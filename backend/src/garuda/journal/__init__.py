"""The journal: folding an append-only event log back into state."""

from garuda.journal.fold import (
    FoldedState,
    JournalFoldError,
    PositionBasis,
    PositionKey,
    PositionMismatch,
    compare_positions,
    fold,
)

__all__ = [
    "FoldedState",
    "JournalFoldError",
    "PositionBasis",
    "PositionKey",
    "PositionMismatch",
    "compare_positions",
    "fold",
]
