"""Choosing a strike.

Two steps, kept apart because they fail differently. **Which strike** a
strategy wants is arithmetic on the spot price and the strike gap, and is
answerable without a chain. **Whether that strike is listed** needs the
instrument master, and a strike the arithmetic likes but the exchange never
listed is a real and ordinary outcome, especially in the wings.

The only vocabulary in use is moneyness: at the money, or a number of strikes
either side of it.

The arithmetic half is here in the domain, on nothing but a price and a gap,
so that market data can locate the money for a synthetic straddle without
reaching up into the engine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from garuda.domain.enums import OptionType
from garuda.domain.errors import DomainError
from garuda.domain.money import Money

#: ``ATM``, or a side and a number of steps: ``OTM2``, ``OTM+2``, ``ITM+1``.
#: A signed suffix is deliberately not accepted -- see :meth:`Moneyness.parse`.
_MONEYNESS = re.compile(r"^(?P<side>ATM|ITM|OTM)(?:\s*\+?\s*(?P<steps>\d+))?$")


@dataclass(frozen=True, slots=True)
class Moneyness:
    """How far from at-the-money a strike sits, in strikes.

    ``steps`` is signed against the money: positive is *out* of the money and
    negative is *in* it, for whichever side is being priced. Zero is at the
    money. One number covers both sides because "one strike out" means the
    strike above for a call and the strike below for a put.
    """

    steps: int = 0

    @property
    def is_at_the_money(self) -> bool:
        return self.steps == 0

    def __str__(self) -> str:
        if self.steps == 0:
            return "ATM"
        return f"{'OTM' if self.steps > 0 else 'ITM'}+{abs(self.steps)}"

    @classmethod
    def parse(cls, text: str) -> Moneyness:
        """Read a configured strike value.

        Accepts ``ATM``, ``ITM``, ``OTM`` and those with a count: ``OTM2`` or
        ``OTM+2``. A bare side means one step.

        **A negative count is refused.** The reference engine accepts
        ``ITM-1`` and resolves it to one strike *out* of the money -- the
        opposite side of at-the-money from what it says -- because the minus
        cancels the inversion that makes ``ITM`` mean the other direction from
        ``OTM``. Rather than copy that, or silently pick one of the two
        readings, this refuses and names them. A strike on the wrong side of
        the money is a different position at a different premium, and nothing
        about it looks wrong afterwards.
        """
        raw = (text or "").strip().upper()
        if not raw:
            raise DomainError("a strike value must say ATM, ITM or OTM")

        match = _MONEYNESS.match(raw)
        if match is None:
            if re.match(r"^(ITM|OTM)\s*-\s*\d+$", raw):
                side, count = raw[:3], raw[3:].strip().lstrip("-")
                other = "OTM" if side == "ITM" else "ITM"
                raise DomainError(
                    f"{raw!r} is ambiguous: it could mean {side}+{count} "
                    f"({count} strike(s) {'in' if side == 'ITM' else 'out of'} the money) "
                    f"or {other}+{count}. Write whichever you mean."
                )
            raise DomainError(f"{raw!r} is not a strike value; expected ATM, ITM+n or OTM+n")

        side = match.group("side")
        if side == "ATM":
            if match.group("steps") not in (None, "0"):
                raise DomainError(
                    f"{raw!r} is at the money and cannot be {match.group('steps')} steps away"
                )
            return cls(0)

        steps = int(match.group("steps") or 1)
        return cls(steps if side == "OTM" else -steps)


#: The default, and the commonest thing a strategy asks for.
AT_THE_MONEY = Moneyness(0)


def atm_strike(spot: Money, gap: Decimal) -> Decimal:
    """The listed strike nearest the spot price.

    Rounds to the nearest multiple of the gap, halves upward. Ties go up
    rather than to even, because at-the-money must be a stable choice: the
    same spot must always name the same strike, however the number happens to
    fall.
    """
    if gap <= 0:
        raise DomainError(f"a strike gap of {gap} cannot space strikes")
    return (spot.amount / gap).quantize(Decimal(1), rounding=ROUND_HALF_UP) * gap


def strike_for(
    moneyness: Moneyness, option_type: OptionType, *, spot: Money, gap: Decimal
) -> Decimal:
    """The strike a leg wants, for its side.

    Out of the money is *above* the spot for a call and *below* it for a put,
    which is why one signed number serves both and why the two legs of a
    strangle at ``OTM+2`` sit either side of the money rather than together.
    """
    at_the_money = atm_strike(spot, gap)
    away = Decimal(moneyness.steps) * gap
    return at_the_money + away if option_type is OptionType.CALL else at_the_money - away
