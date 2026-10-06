"""Authentication: signed-cookie sessions for browsers, HTTP Basic for scripts.

bcrypt is deliberately slow, so verified credentials are cached for a short
while. Without that cache every long-poll from every device would burn ~100ms
of CPU re-hashing the same password.
"""
import functools
import hashlib
import os
import threading
import time

import bcrypt
from flask import g, jsonify, redirect, request, session, url_for

import database

SESSION_KEY = "user_id"
EPOCH_KEY = "epoch"
_CACHE_TTL_SECONDS = 300

_cache = {}
_cache_lock = threading.Lock()


def HashPassword(password):
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _CacheKey(username, password):
    digest = hashlib.sha256(f"{username}\0{password}".encode("utf-8")).hexdigest()
    return f"{username}\0{digest}"


def VerifyCredentials(username, password):
    """Return the matching user, or None. Successful checks are memoised."""
    if not username or not password:
        return None

    key = _CacheKey(username, password)
    now = time.monotonic()

    with _cache_lock:
        cached = _cache.get(key)
        if cached and cached[1] > now:
            userId = cached[0]
        else:
            userId = None

    if userId is not None:
        user = database.GetUserById(userId)
        if user:
            return user

    user = database.GetUserByName(username)
    if user is None:
        # Compare against a dummy hash so unknown users take the same time.
        try:
            bcrypt.checkpw(b"x", b"$2b$12$" + b"." * 53)
        except ValueError:
            pass
        return None

    try:
        matches = bcrypt.checkpw(password.encode("utf-8"), user.PasswordHash.encode("utf-8"))
    except ValueError:
        matches = False

    if not matches:
        return None

    with _cache_lock:
        _cache[key] = (user.UserId, now + _CACHE_TTL_SECONDS)
        if len(_cache) > 64:
            for staleKey, (_, expiry) in list(_cache.items()):
                if expiry <= now:
                    _cache.pop(staleKey, None)

    return user


def InvalidateCache():
    with _cache_lock:
        _cache.clear()


def CurrentUser():
    """Resolve the request's user from the session cookie or a Basic header."""
    if "user" in g:
        return g.user

    user = None
    userId = session.get(SESSION_KEY)
    if userId is not None:
        user = database.GetUserById(userId)
        # A force sign-out bumps the user's SessionEpoch, so a cookie minted
        # before that no longer matches and is treated as signed out.
        if user is None or session.get(EPOCH_KEY) != user.SessionEpoch:
            session.clear()
            user = None

    if user is None and request.authorization and request.authorization.type == "basic":
        user = VerifyCredentials(
            request.authorization.username, request.authorization.password
        )

    g.user = user
    return user


def LogIn(user, remember=True):
    session.clear()
    session[SESSION_KEY] = user.UserId
    session[EPOCH_KEY] = user.SessionEpoch
    session.permanent = remember
    g.user = user


def LogOut():
    session.clear()
    g.pop("user", None)


def LoginRequired(view):
    """Guard a view. API routes get 401 JSON, pages get a redirect."""
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        user = CurrentUser()
        if user is None:
            if request.path.startswith("/api/"):
                return jsonify(error="Not signed in"), 401
            return redirect(url_for("login", next=request.full_path.rstrip("?")))
        return view(*args, **kwargs)

    return wrapper


def AdminRequired(view):
    """Guard a view so only signed-in admins reach it."""
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        user = CurrentUser()
        if user is None:
            if request.path.startswith("/api/"):
                return jsonify(error="Not signed in"), 401
            return redirect(url_for("login", next=request.full_path.rstrip("?")))
        if not user.IsAdmin:
            if request.path.startswith("/api/"):
                return jsonify(error="Admins only"), 403
            return redirect(url_for("index"))
        return view(*args, **kwargs)

    return wrapper


def MayShare(user):
    """Admins can always share; other users only if granted the permission."""
    return bool(user and (user.IsAdmin or user.CanShare))


def LoadOrCreateSecretKey(path):
    """Persist the session key so a restart does not sign everyone out."""
    try:
        with open(path, "rb") as handle:
            key = handle.read().strip()
            if len(key) >= 32:
                return key
    except OSError:
        pass

    key = os.urandom(48).hex().encode("ascii")
    try:
        with open(path, "wb") as handle:
            handle.write(key)
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key
