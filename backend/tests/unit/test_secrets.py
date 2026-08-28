"""Encrypting broker credentials at rest."""

from __future__ import annotations

import pytest

from garuda.domain.errors import DomainError
from garuda.persistence import SecretBox, SecretDecryptionError


class TestRoundTrip:
    def test_a_secret_survives_a_round_trip(self):
        box = SecretBox("a-passphrase")
        assert box.open(box.seal("api-secret-value")) == "api-secret-value"

    def test_the_stored_form_does_not_contain_the_secret(self):
        """The point: a backup or a pg_dump must not carry the credential."""
        sealed = SecretBox("a-passphrase").seal("hunter2")
        assert sealed is not None
        assert "hunter2" not in sealed

    def test_sealing_twice_produces_different_ciphertext(self):
        """Otherwise identical secrets are identifiable by their stored form."""
        box = SecretBox("a-passphrase")
        assert box.seal("same") != box.seal("same")

    def test_nothing_in_means_nothing_out(self):
        box = SecretBox("a-passphrase")
        assert box.seal(None) is None
        assert box.seal("") is None
        assert box.open(None) is None


class TestKeys:
    def test_the_wrong_key_fails_loudly(self):
        """Silently returning nothing would look like a client with no credentials."""
        sealed = SecretBox("the-original-key").seal("api-secret")
        with pytest.raises(SecretDecryptionError, match="secret key has probably changed"):
            SecretBox("a-different-key").open(sealed)

    def test_an_empty_key_is_refused(self):
        with pytest.raises(DomainError, match="no secret key configured"):
            SecretBox("")

    def test_any_passphrase_length_works(self):
        """The operator configures a readable value, not 32 base64 bytes."""
        for key in ("short", "a much longer passphrase with spaces in it"):
            box = SecretBox(key)
            assert box.open(box.seal("value")) == "value"
