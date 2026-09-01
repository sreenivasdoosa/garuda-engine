"""Signing in, and staying signed in.

One admin identity. The password is hashed with Argon2 and compared in
constant time; the session is a short-lived JWT the Console keeps and decodes
for itself, which is why the claims below are the ones its `jwt.ts` reads.

**The default password is a first-run convenience, not a secret.** An
installer sets a real one; until then `garuda@777` gets an operator to the
Console on a machine they already control. It is logged as a warning at
startup so nobody forgets it is there.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

logger = logging.getLogger(__name__)

#: What a fresh install signs in with. See the module docstring.
DEFAULT_ADMIN_PASSWORD = "garuda@777"

#: How long a session lasts. Short, because there is no refresh flow yet and
#: the Console decodes the token rather than asking who it belongs to.
SESSION = timedelta(hours=12)

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def password_matches(hashed: str, offered: str) -> bool:
    """Constant-time comparison. False rather than raising on a mismatch."""
    try:
        return _hasher.verify(hashed, offered)
    except VerifyMismatchError:
        return False
    except Exception:
        logger.exception("stored admin password hash could not be read")
        return False


def issue(username: str, secret: str, *, now: datetime | None = None) -> str:
    """A session token for the admin.

    The claim names are the ones the Console reads. There are no rights in
    them: one operator owns every account on this engine, so being signed in
    is the whole of the authorization model.
    """
    issued = now or datetime.now(UTC)
    claims: dict[str, Any] = {
        "sub": username,
        "username": username,
        "email": "",
        "full_name": "Administrator",
        "role_code": "ADMIN",
        "role_name": "Administrator",
        "iat": int(issued.timestamp()),
        "exp": int((issued + SESSION).timestamp()),
    }
    return jwt.encode(claims, secret, algorithm="HS256")


def read(token: str, secret: str) -> dict[str, Any] | None:
    """The claims, or None if the token is not ours or has expired."""
    try:
        return dict(jwt.decode(token, secret, algorithms=["HS256"]))
    except jwt.PyJWTError:
        return None
