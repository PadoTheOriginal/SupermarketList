"""SQLite persistence layer.

One connection per thread (the dev server is threaded), WAL journaling so
readers never block the writer, and foreign keys enforced so deleting a list
cannot leave orphan items behind.

Access control is by *collaborator*: a list is reachable by its owner and by
anyone it has been shared with, and a shared user is a full co-owner. Every
mutating helper takes the acting ``userId`` and filters through
``_list_access_sql`` so a user can only ever touch a list they can reach, even
if they guess an id belonging to somebody else.
"""
import datetime
import os
import sqlite3
import threading
from contextlib import contextmanager

import models


class DuplicateUsername(Exception):
    """Raised when a username collides with the UNIQUE constraint on Users."""


APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("SUPERMARKET_DB") or os.path.join(APP_DIR, "sqlite.db")

_local = threading.local()
_schema_lock = threading.Lock()
_schema_ready = False

SCHEMA = """
CREATE TABLE IF NOT EXISTS Users (
    UserId          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    Username        varchar(256) NOT NULL UNIQUE,
    PasswordHash    varchar(1200) NOT NULL
);

CREATE TABLE IF NOT EXISTS SupermarketLists (
    SupermarketListId   INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    Name                varchar(100) NOT NULL,
    OwnerId             INTEGER NOT NULL REFERENCES Users(UserId) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS SupermarketItems (
    SupermarketItemId   INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    Name                nvarchar(150) NOT NULL,
    Quantity            NUMERIC NOT NULL DEFAULT 1,
    Price               NUMERIC NOT NULL DEFAULT 0,
    SupermarketListId   INTEGER NOT NULL REFERENCES SupermarketLists(SupermarketListId) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS SupermarketListShares (
    SupermarketListId   INTEGER NOT NULL REFERENCES SupermarketLists(SupermarketListId) ON DELETE CASCADE,
    UserId              INTEGER NOT NULL REFERENCES Users(UserId) ON DELETE CASCADE,
    PRIMARY KEY (SupermarketListId, UserId)
);

CREATE TABLE IF NOT EXISTS LoginEvents (
    LoginEventId    INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    UserId          INTEGER NOT NULL REFERENCES Users(UserId) ON DELETE CASCADE,
    At              TEXT NOT NULL,
    Ip              TEXT,
    UserAgent       TEXT
);
"""

# Columns added after the first release, applied on start-up to existing files.
MIGRATIONS = [
    ("SupermarketLists", "Position", "INTEGER NOT NULL DEFAULT 0"),
    ("SupermarketItems", "Checked", "INTEGER NOT NULL DEFAULT 0"),
    ("SupermarketItems", "Position", "INTEGER NOT NULL DEFAULT 0"),
    ("Users", "IsAdmin", "INTEGER NOT NULL DEFAULT 0"),
    ("Users", "CanShare", "INTEGER NOT NULL DEFAULT 0"),
    ("Users", "SessionEpoch", "INTEGER NOT NULL DEFAULT 0"),
]

INDEXES = [
    "CREATE INDEX IF NOT EXISTS IX_Lists_Owner ON SupermarketLists(OwnerId)",
    "CREATE INDEX IF NOT EXISTS IX_Items_List ON SupermarketItems(SupermarketListId)",
    "CREATE INDEX IF NOT EXISTS IX_Shares_User ON SupermarketListShares(UserId)",
    "CREATE INDEX IF NOT EXISTS IX_Logins_User ON LoginEvents(UserId, LoginEventId)",
]


def GetConnection():
    """Return this thread's connection, creating it (and the schema) on demand."""
    EnsureSchema()

    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _Connect()
        _local.conn = conn
    return conn


def _Connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def EnsureSchema():
    global _schema_ready
    if _schema_ready:
        return

    with _schema_lock:
        if _schema_ready:
            return

        directory = os.path.dirname(DB_PATH)
        if directory:
            os.makedirs(directory, exist_ok=True)

        conn = _Connect()
        try:
            conn.executescript(SCHEMA)

            for table, column, definition in MIGRATIONS:
                columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
                if column not in columns:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

            for statement in INDEXES:
                conn.execute(statement)

            # Give freshly migrated rows a stable order instead of all-zeroes.
            conn.execute(
                "UPDATE SupermarketItems SET Position = SupermarketItemId "
                "WHERE Position = 0"
            )
            conn.execute(
                "UPDATE SupermarketLists SET Position = SupermarketListId "
                "WHERE Position = 0"
            )
            conn.commit()
        finally:
            conn.close()

        _schema_ready = True


@contextmanager
def Transaction():
    """Run a block inside a single transaction, rolling back on error."""
    conn = GetConnection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _utcnow():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


# A list is reachable by the acting user (:uid) when they own it or it has been
# shared with them. ``list_col`` is a (possibly table-qualified) list-id column.
def _list_access_sql(list_col):
    return (
        f"({list_col} IN (SELECT SupermarketListId FROM SupermarketLists WHERE OwnerId = :uid) "
        f"OR {list_col} IN (SELECT SupermarketListId FROM SupermarketListShares WHERE UserId = :uid))"
    )


# --------------------------------------------------------------------------- #
# Users
# --------------------------------------------------------------------------- #

_USER_COLUMNS = "UserId, Username, PasswordHash, IsAdmin, CanShare, SessionEpoch"


def _RowToUser(row):
    return models.User(
        row["UserId"], row["Username"], row["PasswordHash"],
        bool(row["IsAdmin"]), bool(row["CanShare"]), row["SessionEpoch"],
    )


def GetUserByName(username):
    row = GetConnection().execute(
        f"SELECT {_USER_COLUMNS} FROM Users WHERE Username = ?",
        (username,),
    ).fetchone()
    return _RowToUser(row) if row else None


def GetUserById(userId):
    row = GetConnection().execute(
        f"SELECT {_USER_COLUMNS} FROM Users WHERE UserId = ?",
        (userId,),
    ).fetchone()
    return _RowToUser(row) if row else None


def ListUsers():
    """Every account, for the admin user-management screen."""
    return [
        _RowToUser(row)
        for row in GetConnection().execute(
            f"SELECT {_USER_COLUMNS} FROM Users ORDER BY Username COLLATE NOCASE"
        )
    ]


def CountUsers():
    return GetConnection().execute("SELECT Count(*) FROM Users").fetchone()[0]


def CountAdmins():
    return GetConnection().execute(
        "SELECT Count(*) FROM Users WHERE IsAdmin = 1"
    ).fetchone()[0]


def CreateUser(username, passwordHash, isAdmin=False, canShare=False):
    try:
        with Transaction() as conn:
            cur = conn.execute(
                "INSERT INTO Users(Username, PasswordHash, IsAdmin, CanShare) VALUES(?, ?, ?, ?)",
                (username, passwordHash, int(bool(isAdmin)), int(bool(canShare))),
            )
            return models.User(
                cur.lastrowid, username, passwordHash, bool(isAdmin), bool(canShare), 0
            )
    except sqlite3.IntegrityError:
        raise DuplicateUsername(username)


def SetPassword(username, passwordHash):
    with Transaction() as conn:
        cur = conn.execute(
            "UPDATE Users SET PasswordHash = ? WHERE Username = ?",
            (passwordHash, username),
        )
        return cur.rowcount > 0


def SetPasswordById(userId, passwordHash):
    with Transaction() as conn:
        cur = conn.execute(
            "UPDATE Users SET PasswordHash = ? WHERE UserId = ?",
            (passwordHash, userId),
        )
        return cur.rowcount > 0


def SetUsername(userId, username):
    try:
        with Transaction() as conn:
            cur = conn.execute(
                "UPDATE Users SET Username = ? WHERE UserId = ?",
                (username, userId),
            )
            return cur.rowcount > 0
    except sqlite3.IntegrityError:
        raise DuplicateUsername(username)


def SetAdmin(userId, isAdmin):
    with Transaction() as conn:
        cur = conn.execute(
            "UPDATE Users SET IsAdmin = ? WHERE UserId = ?",
            (int(bool(isAdmin)), userId),
        )
        return cur.rowcount > 0


def SetCanShare(userId, canShare):
    with Transaction() as conn:
        cur = conn.execute(
            "UPDATE Users SET CanShare = ? WHERE UserId = ?",
            (int(bool(canShare)), userId),
        )
        return cur.rowcount > 0


def BumpSessionEpoch(userId):
    """Invalidate every existing cookie session for a user (force sign-out)."""
    with Transaction() as conn:
        conn.execute(
            "UPDATE Users SET SessionEpoch = SessionEpoch + 1 WHERE UserId = ?",
            (userId,),
        )


def DeleteUser(userId):
    """Remove an account and everything it owns.

    Older database files were created without ON DELETE CASCADE, so children are
    cleared explicitly rather than relying on the foreign keys.
    """
    with Transaction() as conn:
        conn.execute(
            "DELETE FROM SupermarketItems WHERE SupermarketListId IN "
            "(SELECT SupermarketListId FROM SupermarketLists WHERE OwnerId = ?)",
            (userId,),
        )
        conn.execute(
            "DELETE FROM SupermarketListShares WHERE SupermarketListId IN "
            "(SELECT SupermarketListId FROM SupermarketLists WHERE OwnerId = ?)",
            (userId,),
        )
        conn.execute("DELETE FROM SupermarketLists WHERE OwnerId = ?", (userId,))
        conn.execute("DELETE FROM SupermarketListShares WHERE UserId = ?", (userId,))
        conn.execute("DELETE FROM LoginEvents WHERE UserId = ?", (userId,))
        cur = conn.execute("DELETE FROM Users WHERE UserId = ?", (userId,))
        return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# Login history
# --------------------------------------------------------------------------- #

def RecordLogin(userId, ip, userAgent, keep=25):
    with Transaction() as conn:
        conn.execute(
            "INSERT INTO LoginEvents(UserId, At, Ip, UserAgent) VALUES(?, ?, ?, ?)",
            (userId, _utcnow(), ip, userAgent),
        )
        # Keep only the most recent handful per user.
        conn.execute(
            "DELETE FROM LoginEvents WHERE UserId = ? AND LoginEventId NOT IN "
            "(SELECT LoginEventId FROM LoginEvents WHERE UserId = ? "
            "ORDER BY LoginEventId DESC LIMIT ?)",
            (userId, userId, keep),
        )


def GetLoginEvents(userId, limit=25):
    return [
        {"at": row["At"], "ip": row["Ip"], "userAgent": row["UserAgent"]}
        for row in GetConnection().execute(
            "SELECT At, Ip, UserAgent FROM LoginEvents WHERE UserId = ? "
            "ORDER BY LoginEventId DESC LIMIT ?",
            (userId, limit),
        )
    ]


# --------------------------------------------------------------------------- #
# Lists
# --------------------------------------------------------------------------- #

def _RowToItem(row):
    return models.SupermarketItem(
        row["SupermarketItemId"],
        row["Name"],
        row["Quantity"],
        row["Price"],
        row["SupermarketListId"],
        bool(row["Checked"]),
        row["Position"],
    )


def _RowToList(row, userId):
    supermarketList = models.SupermarketList(
        row["SupermarketListId"], row["Name"], row["OwnerId"], row["Position"]
    )
    supermarketList.OwnerName = row["OwnerName"]
    supermarketList.Shared = row["OwnerId"] != userId
    return supermarketList


def GetAccessibleLists(userId):
    """Every list a user can reach (owned + shared), with their items."""
    conn = GetConnection()

    listRows = conn.execute(
        "SELECT l.SupermarketListId, l.Name, l.OwnerId, l.Position, u.Username AS OwnerName "
        "FROM SupermarketLists l JOIN Users u ON u.UserId = l.OwnerId "
        "WHERE " + _list_access_sql("l.SupermarketListId") + " "
        "ORDER BY l.Position, l.SupermarketListId",
        {"uid": userId},
    ).fetchall()

    lists = [_RowToList(row, userId) for row in listRows]
    byId = {item.SupermarketListId: item for item in lists}
    if not byId:
        return lists

    placeholders = ",".join("?" for _ in byId)
    rows = conn.execute(
        f"SELECT * FROM SupermarketItems WHERE SupermarketListId IN ({placeholders}) "
        "ORDER BY Position, SupermarketItemId",
        tuple(byId.keys()),
    )
    for row in rows:
        byId[row["SupermarketListId"]].SupermarketItems.append(_RowToItem(row))

    return lists


def GetAccessibleList(userId, listId):
    conn = GetConnection()
    row = conn.execute(
        "SELECT l.SupermarketListId, l.Name, l.OwnerId, l.Position, u.Username AS OwnerName "
        "FROM SupermarketLists l JOIN Users u ON u.UserId = l.OwnerId "
        "WHERE l.SupermarketListId = :lid AND " + _list_access_sql("l.SupermarketListId"),
        {"lid": listId, "uid": userId},
    ).fetchone()

    if row is None:
        return None

    supermarketList = _RowToList(row, userId)
    supermarketList.SupermarketItems = [
        _RowToItem(item)
        for item in conn.execute(
            "SELECT * FROM SupermarketItems WHERE SupermarketListId = ? "
            "ORDER BY Position, SupermarketItemId",
            (listId,),
        )
    ]
    return supermarketList


def HasListAccess(userId, listId):
    return GetConnection().execute(
        "SELECT 1 FROM SupermarketLists WHERE SupermarketListId = :lid AND "
        + _list_access_sql("SupermarketListId"),
        {"lid": listId, "uid": userId},
    ).fetchone() is not None


def CreateSupermarketList(ownerId, name):
    with Transaction() as conn:
        position = conn.execute(
            "SELECT IfNull(Max(Position), 0) + 1 FROM SupermarketLists WHERE OwnerId = ?",
            (ownerId,),
        ).fetchone()[0]

        cur = conn.execute(
            "INSERT INTO SupermarketLists(Name, OwnerId, Position) VALUES(?, ?, ?)",
            (name, ownerId, position),
        )
        supermarketList = models.SupermarketList(cur.lastrowid, name, ownerId, position)
        supermarketList.OwnerName = conn.execute(
            "SELECT Username FROM Users WHERE UserId = ?", (ownerId,)
        ).fetchone()["Username"]
        return supermarketList


def RenameSupermarketList(userId, listId, name):
    with Transaction() as conn:
        cur = conn.execute(
            "UPDATE SupermarketLists SET Name = :name WHERE SupermarketListId = :lid AND "
            + _list_access_sql("SupermarketListId"),
            {"name": name, "lid": listId, "uid": userId},
        )
        return cur.rowcount > 0


def DeleteSupermarketList(userId, listId):
    with Transaction() as conn:
        reachable = conn.execute(
            "SELECT 1 FROM SupermarketLists WHERE SupermarketListId = :lid AND "
            + _list_access_sql("SupermarketListId"),
            {"lid": listId, "uid": userId},
        ).fetchone()
        if reachable is None:
            return False

        # Explicit child deletes: older database files predate ON DELETE CASCADE.
        conn.execute("DELETE FROM SupermarketItems WHERE SupermarketListId = ?", (listId,))
        conn.execute("DELETE FROM SupermarketListShares WHERE SupermarketListId = ?", (listId,))
        conn.execute("DELETE FROM SupermarketLists WHERE SupermarketListId = ?", (listId,))
        return True


def DuplicateSupermarketList(userId, listId, name=None):
    source = GetAccessibleList(userId, listId)
    if source is None:
        return None

    # The copy belongs to whoever duplicated it, not the original owner.
    copy = CreateSupermarketList(userId, name or f"{source.Name} (copy)")

    with Transaction() as conn:
        for item in source.SupermarketItems:
            conn.execute(
                "INSERT INTO SupermarketItems(Name, Quantity, Price, SupermarketListId, Checked, Position) "
                "VALUES(?, ?, ?, ?, 0, ?)",
                (item.Name, item.Quantity, item.Price, copy.SupermarketListId, item.Position),
            )

    return GetAccessibleList(userId, copy.SupermarketListId)


def ReorderSupermarketLists(userId, listIds):
    with Transaction() as conn:
        for position, listId in enumerate(listIds, start=1):
            conn.execute(
                "UPDATE SupermarketLists SET Position = :pos WHERE SupermarketListId = :lid AND "
                + _list_access_sql("SupermarketListId"),
                {"pos": position, "lid": listId, "uid": userId},
            )
    return True


# --------------------------------------------------------------------------- #
# Sharing
# --------------------------------------------------------------------------- #

def GetListOwnerId(listId):
    row = GetConnection().execute(
        "SELECT OwnerId FROM SupermarketLists WHERE SupermarketListId = ?", (listId,)
    ).fetchone()
    return row["OwnerId"] if row else None


def CollaboratorIds(listId):
    """Every user id that can reach a list: the owner plus shared users."""
    return [
        row["UserId"]
        for row in GetConnection().execute(
            "SELECT OwnerId AS UserId FROM SupermarketLists WHERE SupermarketListId = :lid "
            "UNION SELECT UserId FROM SupermarketListShares WHERE SupermarketListId = :lid",
            {"lid": listId},
        )
    ]


def GetListCollaborators(listId):
    """The owner and the shared users of a list, each as {id, username, owner}."""
    conn = GetConnection()
    people = []

    owner = conn.execute(
        "SELECT u.UserId, u.Username FROM SupermarketLists l "
        "JOIN Users u ON u.UserId = l.OwnerId WHERE l.SupermarketListId = ?",
        (listId,),
    ).fetchone()
    if owner is None:
        return people
    people.append({"id": owner["UserId"], "username": owner["Username"], "owner": True})

    for row in conn.execute(
        "SELECT u.UserId, u.Username FROM SupermarketListShares s "
        "JOIN Users u ON u.UserId = s.UserId WHERE s.SupermarketListId = ? "
        "ORDER BY u.Username COLLATE NOCASE",
        (listId,),
    ):
        people.append({"id": row["UserId"], "username": row["Username"], "owner": False})

    return people


def ShareList(listId, targetUserId):
    """Grant a user co-ownership of a list. Returns False if it changes nothing."""
    with Transaction() as conn:
        owner = conn.execute(
            "SELECT OwnerId FROM SupermarketLists WHERE SupermarketListId = ?", (listId,)
        ).fetchone()
        if owner is None or owner["OwnerId"] == targetUserId:
            return False
        cur = conn.execute(
            "INSERT OR IGNORE INTO SupermarketListShares(SupermarketListId, UserId) VALUES(?, ?)",
            (listId, targetUserId),
        )
        return cur.rowcount > 0


def UnshareList(listId, targetUserId):
    with Transaction() as conn:
        cur = conn.execute(
            "DELETE FROM SupermarketListShares WHERE SupermarketListId = ? AND UserId = ?",
            (listId, targetUserId),
        )
        return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# Items
# --------------------------------------------------------------------------- #

def GetSupermarketItem(userId, itemId):
    row = GetConnection().execute(
        "SELECT * FROM SupermarketItems WHERE SupermarketItemId = :iid AND "
        + _list_access_sql("SupermarketListId"),
        {"iid": itemId, "uid": userId},
    ).fetchone()
    return _RowToItem(row) if row else None


def GetItemListId(userId, itemId):
    """The list an item belongs to, if the user can reach it."""
    row = GetConnection().execute(
        "SELECT SupermarketListId FROM SupermarketItems WHERE SupermarketItemId = :iid AND "
        + _list_access_sql("SupermarketListId"),
        {"iid": itemId, "uid": userId},
    ).fetchone()
    return row["SupermarketListId"] if row else None


def CreateSupermarketItem(userId, listId, name, quantity, price, checked=False, position=None):
    if not HasListAccess(userId, listId):
        return None

    with Transaction() as conn:
        if position is None:
            position = conn.execute(
                "SELECT IfNull(Max(Position), 0) + 1 FROM SupermarketItems WHERE SupermarketListId = ?",
                (listId,),
            ).fetchone()[0]

        cur = conn.execute(
            "INSERT INTO SupermarketItems(Name, Quantity, Price, SupermarketListId, Checked, Position) "
            "VALUES(?, ?, ?, ?, ?, ?)",
            (name, quantity, price, listId, int(checked), position),
        )
        return models.SupermarketItem(
            cur.lastrowid, name, quantity, price, listId, checked, position
        )


def UpdateSupermarketItem(userId, itemId, fields):
    """Patch the given columns of an item. ``fields`` keys must be trusted."""
    allowed = {"Name", "Quantity", "Price", "Checked"}
    updates = {key: value for key, value in fields.items() if key in allowed}
    if not updates:
        return GetSupermarketItem(userId, itemId)

    if "Checked" in updates:
        updates["Checked"] = int(bool(updates["Checked"]))

    assignments = ", ".join(f"{column} = :{column}" for column in updates)
    parameters = dict(updates)
    parameters["iid"] = itemId
    parameters["uid"] = userId

    with Transaction() as conn:
        conn.execute(
            f"UPDATE SupermarketItems SET {assignments} WHERE SupermarketItemId = :iid AND "
            + _list_access_sql("SupermarketListId"),
            parameters,
        )

    return GetSupermarketItem(userId, itemId)


def DeleteSupermarketItem(userId, itemId):
    """Delete an item and return it, so the client can offer an undo."""
    item = GetSupermarketItem(userId, itemId)
    if item is None:
        return None

    with Transaction() as conn:
        conn.execute(
            "DELETE FROM SupermarketItems WHERE SupermarketItemId = ?", (itemId,)
        )
    return item


def ReorderSupermarketItems(userId, listId, itemIds):
    if not HasListAccess(userId, listId):
        return False

    with Transaction() as conn:
        for position, itemId in enumerate(itemIds, start=1):
            conn.execute(
                "UPDATE SupermarketItems SET Position = ? "
                "WHERE SupermarketItemId = ? AND SupermarketListId = ?",
                (position, itemId, listId),
            )
    return True


def SetAllChecked(userId, listId, checked):
    if not HasListAccess(userId, listId):
        return False

    with Transaction() as conn:
        conn.execute(
            "UPDATE SupermarketItems SET Checked = ? WHERE SupermarketListId = ?",
            (int(bool(checked)), listId),
        )
    return True


def DeleteCheckedItems(userId, listId):
    if not HasListAccess(userId, listId):
        return 0

    with Transaction() as conn:
        cur = conn.execute(
            "DELETE FROM SupermarketItems WHERE SupermarketListId = ? AND Checked = 1",
            (listId,),
        )
        return cur.rowcount
