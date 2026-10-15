"""Finding custom strategies at startup (`STRATEGY_ENGINE.md` §7).

Two places, both optional:

* an installed package exposing a ``garuda.strategies`` entry point -- the
  entry point's module is imported, and its ``@strategy`` decorators do the
  registering;
* a ``plugins`` directory under the app home, each ``*.py`` file imported
  the same way. Drop a file in, restart, and its strategies are named.

A plugin that fails to import is logged by name and skipped; the engine and
every other strategy start regardless, and a definition naming a strategy
that did not load is refused at load like any other unknown name.
"""

from __future__ import annotations

import importlib.util
import logging
from importlib.metadata import entry_points
from pathlib import Path

from garuda.engine.custom_strategies import registered

logger = logging.getLogger(__name__)

ENTRY_POINT_GROUP = "garuda.strategies"


def discover(app_home: Path) -> tuple[str, ...]:
    """Import every plugin; return the custom strategies now registered."""
    for point in entry_points(group=ENTRY_POINT_GROUP):
        try:
            point.load()
        except Exception:
            logger.exception("custom strategy package %s could not be loaded", point.name)
    directory = app_home / "plugins"
    if directory.is_dir():
        for path in sorted(directory.glob("*.py")):
            _load_file(path)
    names = registered()
    if names:
        logger.info("custom strategies registered: %s", ", ".join(names))
    return names


def _load_file(path: Path) -> None:
    name = f"garuda_plugin_{path.stem}"
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot read {path}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception:
        logger.exception("custom strategy file %s could not be loaded", path)
