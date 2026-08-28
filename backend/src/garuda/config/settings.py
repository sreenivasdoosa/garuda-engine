"""Static configuration, validated at startup.

The process refuses to start on an invalid configuration rather than
discovering the problem at the first order. Secrets come from the environment
or a 0600 ``.env`` file, never from the TOML.

Runtime-changeable settings live in the ``system_config`` table and are edited
from the Console; this module is only for what must be known before the engine
can come up.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class DatabaseSettings(BaseSettings):
    """PostgreSQL connection.

    PostgreSQL only: SQLite has no true DECIMAL type, serialises writers, and
    has no timezone-aware timestamp -- all three of which this engine needs.
    """

    # env_file is repeated here on purpose: a nested settings model built by
    # default_factory does not inherit the parent's sources, so without it the
    # database block would read the environment but silently ignore .env.
    model_config = SettingsConfigDict(
        env_prefix="GARUDA_DB_",
        env_file=(".env", "config/.env"),
        extra="ignore",
    )

    host: str = "localhost"
    port: int = 5432
    name: str = "garuda"
    user: str = "garuda"
    password: SecretStr = SecretStr("")
    pool_size: int = Field(default=10, ge=1, le=100)
    pool_max_overflow: int = Field(default=5, ge=0, le=100)
    echo_sql: bool = False

    @property
    def async_url(self) -> str:
        """SQLAlchemy URL for the asyncpg driver.

        A plain property, deliberately not a ``computed_field``: a computed
        field is included in ``repr()`` and in ``model_dump()``, which would
        put the database password into every log line, traceback and
        serialised settings response that touches this object.
        """
        return (
            f"postgresql+asyncpg://{self.user}:{self.password.get_secret_value()}"
            f"@{self.host}:{self.port}/{self.name}"
        )


class Settings(BaseSettings):
    """Everything the engine needs before it can start."""

    model_config = SettingsConfigDict(
        env_prefix="GARUDA_",
        env_nested_delimiter="__",
        env_file=(".env", "config/.env"),
        extra="ignore",
    )

    app_home: Path = Path("/opt/garuda")
    log_directory: Path = Path("/var/log/garuda")
    host: str = "127.0.0.1"
    port: int = Field(default=8080, ge=1, le=65535)
    #: Signs session tokens. The installer generates one; there is no default
    #: worth shipping.
    jwt_secret: SecretStr = SecretStr("")
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)


def load_settings() -> Settings:
    return Settings()
