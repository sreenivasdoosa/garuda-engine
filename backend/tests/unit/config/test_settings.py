"""Configuration loading.

The engine refuses to start on a bad configuration rather than discovering the
problem at the first order, so the loading itself has to be right.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from garuda.config import DatabaseSettings, Settings


@pytest.fixture
def env_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / ".env"
    path.write_text(
        "GARUDA_PORT=9999\n"
        "GARUDA_DB_HOST=db.example.internal\n"
        "GARUDA_DB_PORT=6000\n"
        "GARUDA_DB_PASSWORD=from-the-env-file\n"
    )
    monkeypatch.chdir(tmp_path)
    return path


class TestEnvFile:
    def test_top_level_settings_come_from_the_env_file(self, env_file):
        assert Settings().port == 9999

    def test_the_nested_database_block_also_reads_the_env_file(self, env_file):
        """A nested settings model does not inherit the parent's sources.

        Without env_file declared on DatabaseSettings itself, the database
        block reads the environment but silently ignores .env -- and the first
        symptom is an authentication failure against the right host with the
        wrong password.
        """
        database = Settings().database
        assert database.host == "db.example.internal"
        assert database.port == 6000
        assert database.password.get_secret_value() == "from-the-env-file"

    def test_the_environment_overrides_the_env_file(self, env_file, monkeypatch):
        monkeypatch.setenv("GARUDA_DB_HOST", "override.example.internal")
        assert Settings().database.host == "override.example.internal"


class TestSecrets:
    def test_a_password_does_not_leak_into_a_repr(self):
        settings = DatabaseSettings(password="hunter2")  # type: ignore[arg-type]
        assert "hunter2" not in repr(settings)
        assert "hunter2" not in str(settings)

    def test_the_password_is_still_available_to_the_url_builder(self):
        settings = DatabaseSettings(user="u", password="hunter2", host="h", name="n")  # type: ignore[arg-type]
        assert "hunter2" in settings.async_url


class TestValidation:
    @pytest.mark.parametrize("port", [0, 70000])
    def test_an_impossible_port_is_refused(self, port):
        with pytest.raises(ValidationError):
            Settings(port=port)

    def test_a_non_positive_pool_size_is_refused(self):
        with pytest.raises(ValidationError):
            DatabaseSettings(pool_size=0)

    def test_the_url_names_the_async_driver(self):
        assert DatabaseSettings().async_url.startswith("postgresql+asyncpg://")
