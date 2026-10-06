"""Shopping list web app.

Run it:      python app/main.py
Add a user:  python app/main.py --add-user someone
Change one:  python app/main.py --set-password someone

Everything the browser does goes through the JSON API under /api, so the page
never has to reload to stay in sync.
"""
import argparse
import getpass
import json
import os
import sys
import threading
import time

from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    url_for,
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import auth
import database

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONTENT_DIR = os.path.join(APP_DIR, "content")

# Bumped whenever the CSS/JS changes so browsers do not serve a stale cache.
ASSET_VERSION = "39"

CURRENCY = os.environ.get("SUPERMARKET_CURRENCY", "BRL")
LOCALE = os.environ.get("SUPERMARKET_LOCALE", "pt-BR")

MAX_NAME_LENGTH = 150
MAX_QUANTITY = 100000
MAX_PRICE = 10000000

MIN_PASSWORD_LENGTH = 4
MAX_USERNAME_LENGTH = 256

app = Flask(
    "SupermarketList",
    template_folder=CONTENT_DIR,
    static_folder=CONTENT_DIR,
    static_url_path="/content",
)
app.secret_key = auth.LoadOrCreateSecretKey(os.path.join(APP_DIR, ".secret_key"))
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 90,
    MAX_CONTENT_LENGTH=1024 * 256,
)
app.json.sort_keys = False


class ChangeFeed:
    """Per-user revision counter that clients can long-poll on.

    A device parks on /api/version until somebody changes something, so edits
    on one phone show up on another within milliseconds instead of waiting for
    the next poll tick.
    """

    def __init__(self):
        self._condition = threading.Condition()
        self._versions = {}

    def Version(self, userId):
        with self._condition:
            return self._versions.get(userId, 1)

    def Bump(self, userId):
        with self._condition:
            version = self._versions.get(userId, 1) + 1
            self._versions[userId] = version
            self._condition.notify_all()
            return version

    def Wait(self, userId, since, timeout):
        deadline = time.monotonic() + timeout
        with self._condition:
            while True:
                version = self._versions.get(userId, 1)
                if version != since:
                    return version
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return version
                self._condition.wait(min(remaining, 1.0))


changes = ChangeFeed()


# --------------------------------------------------------------------------- #
# Request helpers
# --------------------------------------------------------------------------- #

class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def HandleApiError(error):
    return jsonify(error=error.message), error.status


@app.errorhandler(database.DuplicateUsername)
def HandleDuplicateUsername(error):
    return jsonify(error="That username is already taken"), 409


@app.errorhandler(404)
def HandleNotFound(error):
    if request.path.startswith("/api/"):
        return jsonify(error="Not found"), 404
    return redirect(url_for("index"))


@app.errorhandler(500)
def HandleServerError(error):
    app.logger.exception("Unhandled error on %s", request.path)
    if request.path.startswith("/api/"):
        return jsonify(error="Something went wrong on the server"), 500
    return "Internal server error", 500


def Payload():
    """Body of a mutating request.

    Requiring JSON (rather than form encoding) is also what keeps a random
    cross-site form from driving the API with the user's session cookie.
    """
    data = request.get_json(silent=True)
    if data is None or not isinstance(data, dict):
        raise ApiError("Expected a JSON object body")
    return data


def ParseName(value, field="Name"):
    name = (value or "").strip()
    if not name:
        raise ApiError(f"{field} cannot be empty")
    if len(name) > MAX_NAME_LENGTH:
        raise ApiError(f"{field} is too long (max {MAX_NAME_LENGTH} characters)")
    return name


def ParseQuantity(value):
    try:
        quantity = float(value)
    except (TypeError, ValueError):
        raise ApiError("Quantity must be a number")
    if quantity != quantity or quantity in (float("inf"), float("-inf")):
        raise ApiError("Quantity must be a number")
    quantity = round(max(0.001, min(quantity, MAX_QUANTITY)), 3)
    return int(quantity) if quantity.is_integer() else quantity


def ParsePrice(value):
    try:
        price = float(value)
    except (TypeError, ValueError):
        raise ApiError("Price must be a number")
    if price != price or price in (float("inf"), float("-inf")):
        raise ApiError("Price must be a number")
    return round(max(0.0, min(price, MAX_PRICE)), 2)


def ParseIdList(value):
    if not isinstance(value, list):
        raise ApiError("Expected a list of ids")
    try:
        return [int(identifier) for identifier in value]
    except (TypeError, ValueError):
        raise ApiError("Ids must be integers")


def ParseUsername(value):
    username = (value or "").strip()
    if not username:
        raise ApiError("Username cannot be empty")
    if len(username) > MAX_USERNAME_LENGTH:
        raise ApiError(f"Username is too long (max {MAX_USERNAME_LENGTH} characters)")
    return username


def ParsePassword(value):
    password = value if isinstance(value, str) else ""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ApiError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    return password


def StatePayload(user):
    lists = database.GetAccessibleLists(user.UserId)
    return {
        "version": changes.Version(user.UserId),
        "user": user.ToDict(),
        "currency": CURRENCY,
        "locale": LOCALE,
        "lists": [supermarketList.ToDict() for supermarketList in lists],
    }


def BumpCollaborators(listId, actingUserId, collaborators=None):
    """Advance the change feed for everyone who can see a list.

    A shared list is watched by several users, so a single edit has to wake all
    of their long-polls. Returns the acting user's new version (or their current
    one when they are not themselves a collaborator, e.g. an admin acting on
    somebody else's list).
    """
    ids = set(collaborators if collaborators is not None else database.CollaboratorIds(listId))
    mine = None
    for userId in ids:
        version = changes.Bump(userId)
        if userId == actingUserId:
            mine = version
    return mine if mine is not None else changes.Version(actingUserId)


@app.after_request
def AddHeaders(response):
    if request.path.startswith("/api/") or request.path == "/":
        response.headers["Cache-Control"] = "no-store"
    elif request.path.startswith("/content/"):
        response.headers["Cache-Control"] = "public, max-age=31536000"
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


# --------------------------------------------------------------------------- #
# Pages
# --------------------------------------------------------------------------- #

@app.route("/")
@auth.LoginRequired
def index():
    user = auth.CurrentUser()

    # Embedded in a <script type="application/json"> block, so "<" must not be
    # able to close the tag early.
    state_json = json.dumps(StatePayload(user)).replace("<", "\\u003c")

    return render_template(
        "index.jinja2",
        state_json=state_json,
        username=user.Username,
        asset_version=ASSET_VERSION,
    )


@app.route("/login", methods=["GET", "POST"])
def login():
    if auth.CurrentUser() is not None and request.method == "GET":
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        user = auth.VerifyCredentials(username, password)

        if user is not None:
            auth.LogIn(user, remember=bool(request.form.get("remember")))
            database.RecordLogin(
                user.UserId,
                request.headers.get("X-Forwarded-For", request.remote_addr),
                request.headers.get("User-Agent"),
            )
            target = request.args.get("next") or url_for("index")
            if not target.startswith("/") or target.startswith("//"):
                target = url_for("index")
            return redirect(target)

        error = "Wrong username or password"

    return (
        render_template("login.jinja2", error=error, asset_version=ASSET_VERSION),
        401 if error else 200,
    )


@app.route("/logout", methods=["GET", "POST"])
def logout():
    auth.LogOut()
    return redirect(url_for("login"))


@app.route("/manifest.webmanifest")
def manifest():
    return send_from_directory(CONTENT_DIR, "manifest.webmanifest")


@app.route("/sw.js")
def service_worker():
    # Served from the root so the worker's scope covers the whole app.
    response = send_from_directory(CONTENT_DIR, "sw.js")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/icon.svg")
def icon():
    return send_from_directory(CONTENT_DIR, "icon.svg")


# --------------------------------------------------------------------------- #
# API - state and sync
# --------------------------------------------------------------------------- #

@app.route("/api/state")
@auth.LoginRequired
def api_state():
    return jsonify(StatePayload(auth.CurrentUser()))


@app.route("/api/version")
@auth.LoginRequired
def api_version():
    user = auth.CurrentUser()
    since = request.args.get("since", type=int)
    wait = min(max(request.args.get("wait", default=0, type=int), 0), 60)

    if since is not None and wait:
        version = changes.Wait(user.UserId, since, wait)
    else:
        version = changes.Version(user.UserId)

    return jsonify(version=version)


# --------------------------------------------------------------------------- #
# API - lists
# --------------------------------------------------------------------------- #

@app.route("/api/lists", methods=["POST"])
@auth.LoginRequired
def api_create_list():
    user = auth.CurrentUser()
    name = ParseName(Payload().get("name"))

    supermarketList = database.CreateSupermarketList(user.UserId, name)
    version = changes.Bump(user.UserId)

    return jsonify(list=supermarketList.ToDict(), version=version), 201


@app.route("/api/lists/reorder", methods=["POST"])
@auth.LoginRequired
def api_reorder_lists():
    user = auth.CurrentUser()
    database.ReorderSupermarketLists(user.UserId, ParseIdList(Payload().get("ids")))
    return jsonify(version=changes.Bump(user.UserId))


@app.route("/api/lists/<int:listId>", methods=["PATCH", "DELETE"])
@auth.LoginRequired
def api_update_list(listId):
    user = auth.CurrentUser()

    if request.method == "DELETE":
        # Capture who could see the list before it (and its shares) disappear,
        # so their devices are told to drop it too.
        collaborators = database.CollaboratorIds(listId)
        if not database.DeleteSupermarketList(user.UserId, listId):
            raise ApiError("List not found", 404)
        version = BumpCollaborators(listId, user.UserId, collaborators)
        return jsonify(deleted=listId, version=version)

    name = ParseName(Payload().get("name"))
    if not database.RenameSupermarketList(user.UserId, listId, name):
        raise ApiError("List not found", 404)

    supermarketList = database.GetAccessibleList(user.UserId, listId)
    return jsonify(
        list=supermarketList.ToDict(),
        version=BumpCollaborators(listId, user.UserId),
    )


@app.route("/api/lists/<int:listId>/duplicate", methods=["POST"])
@auth.LoginRequired
def api_duplicate_list(listId):
    user = auth.CurrentUser()

    copy = database.DuplicateSupermarketList(user.UserId, listId)
    if copy is None:
        raise ApiError("List not found", 404)

    # The copy is owned solely by the duplicator, so only their feed changes.
    return jsonify(list=copy.ToDict(), version=changes.Bump(user.UserId)), 201


@app.route("/api/lists/<int:listId>/items", methods=["POST"])
@auth.LoginRequired
def api_create_item(listId):
    user = auth.CurrentUser()
    data = Payload()

    item = database.CreateSupermarketItem(
        user.UserId,
        listId,
        ParseName(data.get("name")),
        ParseQuantity(data.get("quantity", 1)),
        ParsePrice(data.get("price", 0)),
        checked=bool(data.get("checked", False)),
    )
    if item is None:
        raise ApiError("List not found", 404)

    return jsonify(item=item.ToDict(), version=BumpCollaborators(listId, user.UserId)), 201


@app.route("/api/lists/<int:listId>/items/reorder", methods=["POST"])
@auth.LoginRequired
def api_reorder_items(listId):
    user = auth.CurrentUser()

    if not database.ReorderSupermarketItems(
        user.UserId, listId, ParseIdList(Payload().get("ids"))
    ):
        raise ApiError("List not found", 404)

    return jsonify(version=BumpCollaborators(listId, user.UserId))


@app.route("/api/lists/<int:listId>/checked", methods=["POST", "DELETE"])
@auth.LoginRequired
def api_list_checked(listId):
    """POST sets every item's checked flag; DELETE removes checked items."""
    user = auth.CurrentUser()

    if request.method == "DELETE":
        if not database.HasListAccess(user.UserId, listId):
            raise ApiError("List not found", 404)
        removed = database.DeleteCheckedItems(user.UserId, listId)
        return jsonify(removed=removed, version=BumpCollaborators(listId, user.UserId))

    checked = bool(Payload().get("checked", False))
    if not database.SetAllChecked(user.UserId, listId, checked):
        raise ApiError("List not found", 404)

    return jsonify(version=BumpCollaborators(listId, user.UserId))


# --------------------------------------------------------------------------- #
# API - items
# --------------------------------------------------------------------------- #

@app.route("/api/items/<int:itemId>", methods=["PATCH", "DELETE"])
@auth.LoginRequired
def api_update_item(itemId):
    user = auth.CurrentUser()

    if request.method == "DELETE":
        item = database.DeleteSupermarketItem(user.UserId, itemId)
        if item is None:
            raise ApiError("Item not found", 404)
        return jsonify(
            item=item.ToDict(),
            version=BumpCollaborators(item.SupermarketListId, user.UserId),
        )

    data = Payload()
    fields = {}
    if "name" in data:
        fields["Name"] = ParseName(data["name"])
    if "quantity" in data:
        fields["Quantity"] = ParseQuantity(data["quantity"])
    if "price" in data:
        fields["Price"] = ParsePrice(data["price"])
    if "checked" in data:
        fields["Checked"] = bool(data["checked"])

    item = database.UpdateSupermarketItem(user.UserId, itemId, fields)
    if item is None:
        raise ApiError("Item not found", 404)

    return jsonify(
        item=item.ToDict(),
        version=BumpCollaborators(item.SupermarketListId, user.UserId),
    )


# --------------------------------------------------------------------------- #
# API - sharing
# --------------------------------------------------------------------------- #

def _CanManageShares(user, listId):
    """An admin may share any list; anyone else needs the permission and access."""
    if user.IsAdmin:
        return database.GetListOwnerId(listId) is not None
    return auth.MayShare(user) and database.HasListAccess(user.UserId, listId)


@app.route("/api/share-targets")
@auth.LoginRequired
def api_share_targets():
    """Users a list can be shared with (everyone but yourself)."""
    user = auth.CurrentUser()
    if not auth.MayShare(user):
        raise ApiError("You are not allowed to share lists", 403)
    return jsonify(users=[
        {"id": other.UserId, "username": other.Username}
        for other in database.ListUsers()
        if other.UserId != user.UserId
    ])


@app.route("/api/lists/<int:listId>/shares", methods=["GET", "POST"])
@auth.LoginRequired
def api_list_shares(listId):
    user = auth.CurrentUser()

    if request.method == "GET":
        if not (user.IsAdmin or database.HasListAccess(user.UserId, listId)):
            raise ApiError("List not found", 404)
        if database.GetListOwnerId(listId) is None:
            raise ApiError("List not found", 404)
        return jsonify(
            collaborators=database.GetListCollaborators(listId),
            canManage=_CanManageShares(user, listId),
        )

    if not _CanManageShares(user, listId):
        raise ApiError("You are not allowed to share this list", 403)

    targetId = Payload().get("userId")
    try:
        targetId = int(targetId)
    except (TypeError, ValueError):
        raise ApiError("A user id is required")

    if database.GetUserById(targetId) is None:
        raise ApiError("User not found", 404)

    database.ShareList(listId, targetId)
    version = BumpCollaborators(listId, user.UserId)
    return jsonify(collaborators=database.GetListCollaborators(listId), version=version), 201


@app.route("/api/lists/<int:listId>/shares/<int:targetId>", methods=["DELETE"])
@auth.LoginRequired
def api_remove_share(listId, targetId):
    user = auth.CurrentUser()

    # You can always remove yourself from a list shared with you; otherwise you
    # need permission to manage the list's sharing.
    if targetId != user.UserId and not _CanManageShares(user, listId):
        raise ApiError("You are not allowed to change this list's sharing", 403)

    collaborators = database.CollaboratorIds(listId)
    if not database.UnshareList(listId, targetId):
        raise ApiError("That user is not a collaborator", 404)

    version = BumpCollaborators(listId, user.UserId, collaborators)
    return jsonify(collaborators=database.GetListCollaborators(listId), version=version)


# --------------------------------------------------------------------------- #
# API - the signed-in user's own account
# --------------------------------------------------------------------------- #

@app.route("/api/account/username", methods=["POST"])
@auth.AdminRequired
def api_change_username():
    user = auth.CurrentUser()
    username = ParseUsername(Payload().get("username"))

    if username != user.Username:
        database.SetUsername(user.UserId, username)
        auth.InvalidateCache()

    return jsonify(user=database.GetUserById(user.UserId).ToDict())


@app.route("/api/account/password", methods=["POST"])
@auth.LoginRequired
def api_change_password():
    user = auth.CurrentUser()
    data = Payload()

    current = data.get("currentPassword") or ""
    if auth.VerifyCredentials(user.Username, current) is None:
        raise ApiError("Your current password is not correct", 403)

    newPassword = ParsePassword(data.get("newPassword"))
    database.SetPasswordById(user.UserId, auth.HashPassword(newPassword))
    auth.InvalidateCache()

    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# API - user management (admins only)
# --------------------------------------------------------------------------- #

@app.route("/api/users", methods=["GET"])
@auth.AdminRequired
def api_list_users():
    return jsonify(users=[u.ToDict() for u in database.ListUsers()])


@app.route("/api/users", methods=["POST"])
@auth.AdminRequired
def api_create_user():
    data = Payload()
    username = ParseUsername(data.get("username"))
    password = ParsePassword(data.get("password"))
    isAdmin = bool(data.get("isAdmin", False))
    canShare = bool(data.get("canShare", False))

    user = database.CreateUser(username, auth.HashPassword(password), isAdmin, canShare)
    return jsonify(user=user.ToDict()), 201


@app.route("/api/users/<int:userId>", methods=["PATCH", "DELETE"])
@auth.AdminRequired
def api_update_user(userId):
    current = auth.CurrentUser()
    target = database.GetUserById(userId)
    if target is None:
        raise ApiError("User not found", 404)

    if request.method == "DELETE":
        if target.UserId == current.UserId:
            raise ApiError("You cannot delete your own account", 400)
        if target.IsAdmin and database.CountAdmins() <= 1:
            raise ApiError("You cannot delete the last admin", 400)
        database.DeleteUser(userId)
        auth.InvalidateCache()
        return jsonify(deleted=userId)

    data = Payload()

    if "isAdmin" in data:
        isAdmin = bool(data["isAdmin"])
        if target.UserId == current.UserId and isAdmin != bool(target.IsAdmin):
            raise ApiError("You cannot change your own admin status", 400)
        if target.IsAdmin and not isAdmin and database.CountAdmins() <= 1:
            raise ApiError("There must be at least one admin", 400)
        database.SetAdmin(userId, isAdmin)

    if "canShare" in data:
        database.SetCanShare(userId, bool(data["canShare"]))

    if "username" in data:
        username = ParseUsername(data["username"])
        if username != target.Username:
            database.SetUsername(userId, username)
            auth.InvalidateCache()

    if data.get("password"):
        database.SetPasswordById(userId, auth.HashPassword(ParsePassword(data["password"])))
        auth.InvalidateCache()
        # A reset password should not leave old sessions logged in.
        database.BumpSessionEpoch(userId)

    return jsonify(user=database.GetUserById(userId).ToDict())


@app.route("/api/users/<int:userId>/lists")
@auth.AdminRequired
def api_user_lists(userId):
    if database.GetUserById(userId) is None:
        raise ApiError("User not found", 404)
    lists = database.GetAccessibleLists(userId)
    return jsonify(lists=[supermarketList.ToDict() for supermarketList in lists])


@app.route("/api/users/<int:userId>/logins")
@auth.AdminRequired
def api_user_logins(userId):
    if database.GetUserById(userId) is None:
        raise ApiError("User not found", 404)
    return jsonify(events=database.GetLoginEvents(userId))


@app.route("/api/users/<int:userId>/logout", methods=["POST"])
@auth.AdminRequired
def api_force_logout(userId):
    current = auth.CurrentUser()
    if database.GetUserById(userId) is None:
        raise ApiError("User not found", 404)
    if userId == current.UserId:
        raise ApiError("Use the sign-out button for your own account", 400)
    database.BumpSessionEpoch(userId)
    auth.InvalidateCache()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# Command line
# --------------------------------------------------------------------------- #

def EnsureDefaultUser():
    database.EnsureSchema()
    if database.CountUsers() == 0:
        database.CreateUser("admin@admin", auth.HashPassword("admin"), isAdmin=True)
        app.logger.warning(
            "No users found - created 'admin@admin' with password 'admin'. "
            "Change it with: python app/main.py --set-password admin@admin"
        )
    elif database.CountAdmins() == 0:
        # Upgrading a database from before roles existed: promote the oldest
        # account so somebody can reach the user-management screen.
        promoted = database.ListUsers()
        if promoted:
            oldest = min(promoted, key=lambda u: u.UserId)
            database.SetAdmin(oldest.UserId, True)
            app.logger.warning("Promoted %r to admin.", oldest.Username)


def AddUser(username, isAdmin=False):
    database.EnsureSchema()
    if database.GetUserByName(username):
        print(f"User {username!r} already exists.")
        return 1

    password = getpass.getpass("Password: ")
    if password != getpass.getpass("Repeat password: "):
        print("Passwords do not match.")
        return 1
    if len(password) < 4:
        print("Password is too short.")
        return 1

    database.CreateUser(username, auth.HashPassword(password), isAdmin=isAdmin)
    print(f"Created {'admin ' if isAdmin else ''}user {username!r}.")
    return 0


def SetUserPassword(username):
    database.EnsureSchema()
    if not database.GetUserByName(username):
        print(f"No such user: {username!r}")
        return 1

    password = getpass.getpass("New password: ")
    if password != getpass.getpass("Repeat password: "):
        print("Passwords do not match.")
        return 1

    database.SetPassword(username, auth.HashPassword(password))
    auth.InvalidateCache()
    print(f"Updated password for {username!r}.")
    return 0


def Main():
    parser = argparse.ArgumentParser(description="Shopping list server")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8989)))
    parser.add_argument("--debug", action="store_true", default=bool(os.environ.get("DEBUG")))
    parser.add_argument("--add-user", metavar="USERNAME")
    parser.add_argument("--admin", action="store_true", help="With --add-user, make the new user an admin")
    parser.add_argument("--set-password", metavar="USERNAME")
    arguments = parser.parse_args()

    if arguments.add_user:
        return AddUser(arguments.add_user, isAdmin=arguments.admin)
    if arguments.set_password:
        return SetUserPassword(arguments.set_password)

    EnsureDefaultUser()

    certificates = os.path.join(os.path.dirname(APP_DIR), "certificates")
    sslContext = None
    port = arguments.port

    if os.path.isdir(certificates):
        sslContext = (
            os.path.join(certificates, "cert.pem"),
            os.path.join(certificates, "key.pem"),
        )
        port = int(os.environ.get("PORT", 443))

    print(f"Shopping list running on http{'s' if sslContext else ''}://{arguments.host}:{port}")
    app.run(
        arguments.host,
        port,
        debug=arguments.debug,
        use_reloader=arguments.debug,
        threaded=True,
        ssl_context=sslContext,
    )
    return 0


if os.environ.get("FLASK_RUN_FROM_CLI"):
    # Started with `flask run` rather than `python app/main.py`.
    EnsureDefaultUser()


if __name__ == "__main__":
    sys.exit(Main())
