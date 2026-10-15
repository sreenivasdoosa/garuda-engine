"""Custom strategies dropped into the app home's plugins directory are found."""

from __future__ import annotations

from pathlib import Path

from garuda.composition.plugins import discover
from garuda.engine.custom_strategies import is_registered, unregister


def test_a_plugin_file_registers_its_strategy(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    plugins.mkdir()
    (plugins / "mine.py").write_text(
        "from garuda.engine import BaseStrategy, strategy\n\n"
        "@strategy('FROM_A_FILE')\n"
        "class FromAFile(BaseStrategy):\n"
        "    pass\n"
    )
    try:
        assert "FROM_A_FILE" in discover(tmp_path)
        assert is_registered("FROM_A_FILE")
    finally:
        unregister("FROM_A_FILE")


def test_a_broken_plugin_is_skipped_not_fatal(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    plugins.mkdir()
    (plugins / "broken.py").write_text("raise RuntimeError('nope')\n")
    discover(tmp_path)  # logs and carries on


def test_no_plugins_directory_is_fine(tmp_path: Path) -> None:
    discover(tmp_path)
