#!/usr/bin/env python3
"""Fail the build on a direct read of wall-clock time.

Every instant and every delay goes through the ``Clock`` protocol. That is what
lets a recorded journal replay byte-identically: a single ``datetime.now()``
buried in an exit rule makes the replay diverge from the original run, and the
divergence shows up as an unexplained difference in a P&L figure rather than as
an error.

Only ``core/clock.py`` may call these.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

#: attribute name -> the module it must be called on
FORBIDDEN_ATTRS = {
    "now": {"datetime", "date"},
    "utcnow": {"datetime"},
    "today": {"date", "datetime"},
    "sleep": {"asyncio", "time"},
    "monotonic": {"time"},
    "perf_counter": {"time"},
}

#: names that must not be imported directly, e.g. ``from asyncio import sleep``
FORBIDDEN_IMPORTS = {("asyncio", "sleep"), ("time", "sleep"), ("time", "monotonic")}

#: the one file allowed to do all of this
EXEMPT = {Path("core") / "clock.py"}


class ClockFinder(ast.NodeVisitor):
    def __init__(self) -> None:
        self.violations: list[tuple[int, str]] = []

    def visit_Attribute(self, node: ast.Attribute) -> None:
        owners = FORBIDDEN_ATTRS.get(node.attr)
        if owners and isinstance(node.value, ast.Name) and node.value.id in owners:
            self.violations.append((node.lineno, f"{node.value.id}.{node.attr}()"))
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            if (node.module, alias.name) in FORBIDDEN_IMPORTS:
                self.violations.append((node.lineno, f"from {node.module} import {alias.name}"))
        self.generic_visit(node)


def main() -> int:
    root = Path(__file__).resolve().parent.parent / "src" / "garuda"
    failures = 0
    for path in sorted(root.rglob("*.py")):
        if path.relative_to(root) in EXEMPT:
            continue
        finder = ClockFinder()
        finder.visit(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
        for lineno, what in finder.violations:
            print(f"{path}:{lineno}: {what} — use the Clock protocol")
            failures += 1
    if failures:
        print(f"\n{failures} direct clock read(s). Deterministic replay depends on this.")
        return 1
    print("clock discipline holds: no direct wall-clock reads outside core/clock.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
