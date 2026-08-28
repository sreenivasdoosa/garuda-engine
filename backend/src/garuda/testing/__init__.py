"""Test infrastructure that ships with the engine.

The session harness and, later, the broker adapter contract suite. Shipped
rather than kept in tests/ so a third-party adapter can be checked against the
same suite the built-in ones are.
"""

from garuda.testing.harness import SessionHarness, SessionOutcome, comparable

__all__ = ["SessionHarness", "SessionOutcome", "comparable"]
