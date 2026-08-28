"""Encrypting broker credentials at rest.

An API secret in a plaintext column is a credential in every backup, every
``pg_dump``, and every screenshot of a database client. The engine holds real
trading credentials, so they are encrypted with a key that lives outside the
database -- in the environment or the 0600 secrets file, alongside the JWT
secret.

This is not protection against someone who has the machine. It is protection
against the database file, a backup, or a replica leaving the machine, which is
the realistic way credentials escape.
"""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from garuda.domain.errors import DomainError


class SecretDecryptionError(DomainError):
    """A stored secret could not be read with the configured key.

    Almost always the key changed. Deliberately loud: silently returning
    nothing would look like a client with no credentials, and the operator
    would re-enter them rather than fix the key.
    """


class SecretBox:
    """Encrypts and decrypts credentials with one symmetric key."""

    def __init__(self, key: str) -> None:
        if not key:
            raise DomainError(
                "no secret key configured; broker credentials cannot be stored safely"
            )
        # Fernet needs 32 url-safe base64 bytes. Deriving from a passphrase
        # keeps the operator's configuration a single readable value.
        digest = hashlib.sha256(key.encode("utf-8")).digest()
        self._fernet = Fernet(base64.urlsafe_b64encode(digest))

    def seal(self, plaintext: str | None) -> str | None:
        if plaintext is None or plaintext == "":
            return None
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("ascii")

    def open(self, ciphertext: str | None) -> str | None:
        if ciphertext is None or ciphertext == "":
            return None
        try:
            return self._fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except InvalidToken as error:
            raise SecretDecryptionError(
                "a stored credential could not be decrypted; the secret key has "
                "probably changed since it was saved"
            ) from error
