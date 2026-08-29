"""When a square-off may still be attempted, and when trying stops helping.

Two questions, both of which the reference engine answers with hard-won care.

**Is there still time?** Past the exchange's close nothing can fill, and for an
intraday product the broker stops accepting square-offs earlier still. Past
either point, retrying places orders that can only be rejected -- and the
engine that keeps retrying spams the broker and the operator both.

**Is anything actually wrong?** A deep out-of-the-money option on expiry day
cannot be sold: there is no bid. It will settle worthless on its own, which is
the same outcome as squaring it off, so failing to exit it is not an incident
and must not be paged as one. Everything else that will not exit is.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from garuda.domain.enums import InstrumentKind, ProductType
from garuda.domain.money import Money
from garuda.domain.trade import Trade

#: A premium at or below which an option on its expiry day is treated as
#: settling worthless rather than as a position that could not be closed.
DEFAULT_WORTHLESS_OPTION_PRICE = Decimal("0.5")

#: Products squared off by the exchange itself at the end of the day, and so
#: subject to the broker's earlier cut-off.
_INTRADAY_PRODUCTS = frozenset({ProductType.MIS, ProductType.CO, ProductType.BO})


@dataclass(frozen=True, slots=True)
class ExitWindow:
    """When square-offs may be attempted for one venue today."""

    #: Nothing fills after this.
    market_close: datetime
    #: Intraday products stop being squared off here, earlier than the close,
    #: because the broker begins its own forced closure.
    intraday_block: datetime | None = None

    def is_closed_for(self, product: ProductType, now: datetime) -> bool:
        if now >= self.market_close:
            return True
        if self.intraday_block is None or product not in _INTRADAY_PRODUCTS:
            return False
        return now >= self.intraday_block


def is_retry_window_closed(trade: Trade, window: ExitWindow, now: datetime) -> bool:
    """Whether trying again can still achieve anything.

    A carry-forward position stays squareable until the close; an intraday one
    stops earlier, when the broker takes over. Past either, an attempt can only
    be rejected.
    """
    if trade.is_terminal:
        return False
    return window.is_closed_for(trade.product, now)


def is_worthless_option_at_expiry(
    last_price: Money | None,
    *,
    is_expiry_day: bool,
    instrument_kind: InstrumentKind | None,
    threshold: Decimal = DEFAULT_WORTHLESS_OPTION_PRICE,
) -> bool:
    """Whether a position that will not exit is simply going to expire.

    A deep out-of-the-money option on expiry day has no bid: there is nobody
    to sell it to, and it settles worthless in a few hours. That is the same
    outcome as squaring it off, so the failure to exit is not something to page
    an operator about at eleven at night.

    Conservative in both directions -- without a price, or off expiry day, or
    on anything that is not an option, the answer is no and the failure is
    reported as one.
    """
    if not is_expiry_day or instrument_kind is not InstrumentKind.OPTION:
        return False
    if last_price is None or last_price.amount <= 0:
        return False
    return last_price.amount <= threshold
