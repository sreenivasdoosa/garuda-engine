"""What an order is for, within a trade.

The same broker status means opposite things depending on which order it
belongs to. FILLED on the entry means a position was opened; FILLED on the
stop means it was closed at a loss; FILLED on the target means it was closed
at a profit. Nothing downstream can tell them apart without this.
"""

from __future__ import annotations

from enum import StrEnum


class OrderRole(StrEnum):
    #: Opens the position.
    ENTRY = "ENTRY"
    #: Closes it if the market goes against it.
    STOP = "STOP"
    #: Closes it at a profit, or on a square-off.
    TARGET = "TARGET"
    #: Replaced in its role but possibly still live at the broker. A trailing
    #: stop leaves one of these behind every time it moves, and a fill on one
    #: is still a real exit.
    SUPERSEDED = "SUPERSEDED"
