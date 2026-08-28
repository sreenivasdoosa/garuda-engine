#!/usr/bin/env python3
"""Fail the build on a float in a money or price path.

Binary floating point cannot represent 0.1, so it cannot represent a paisa.
One float upstream of a P&L figure makes that figure wrong in a way that is
very hard to trace, and the failure is silent -- the number still looks like a
number. So the rule is mechanical rather than a review convention.

Scope is the packages that touch money, not the whole codebase: an indicator
computing an RSI in float is fine, an order value computed in float is not.

Allowed, deliberately: ``float`` as an ``isinstance`` argument, which is how
the guards themselves are written.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

#: Packages where every amount must be exact.
MONEY_PATHS = (
    "domain",
    "ordermgmt",
    "trademgmt",
    "rms",
    "capital",
    "journal",
    "reports",
)


class FloatFinder(ast.NodeVisitor):
    def __init__(self, path: Path) -> None:
        self.path = path
        self.violations: list[tuple[int, str]] = []

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, float):
            self.violations.append((node.lineno, f"float literal {node.value!r}"))
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Name) and node.func.id == "float":
            self.violations.append((node.lineno, "float() conversion"))
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        self._check_annotation(node.annotation)
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._check_signature(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._check_signature(node)
        self.generic_visit(node)

    def _check_signature(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        args = node.args
        for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg, args.kwarg):
            if arg is not None and arg.annotation is not None:
                self._check_annotation(arg.annotation)
        if node.returns is not None:
            self._check_annotation(node.returns)

    def _check_annotation(self, annotation: ast.expr) -> None:
        for node in ast.walk(annotation):
            if isinstance(node, ast.Name) and node.id == "float":
                self.violations.append((node.lineno, "float in a type annotation"))
            # A stringified annotation, e.g. "float | None".
            elif (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and "float" in node.value
            ):
                self.violations.append((node.lineno, "float in a string annotation"))


def check(root: Path) -> int:
    failures = 0
    for package in MONEY_PATHS:
        for path in sorted((root / package).rglob("*.py")):
            finder = FloatFinder(path)
            finder.visit(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
            for lineno, what in finder.violations:
                print(f"{path}:{lineno}: {what} in a money path")
                failures += 1
    return failures


def main() -> int:
    root = Path(__file__).resolve().parent.parent / "src" / "garuda"
    failures = check(root)
    if failures:
        print(f"\n{failures} float(s) in money paths. Use Decimal.")
        return 1
    print(f"no floats in money paths ({', '.join(MONEY_PATHS)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
