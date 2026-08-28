"""The Zerodha instrument master.

Kite publishes the whole tradable universe as a CSV. The engine parses it into
canonical instruments and keeps the broker's numeric token beside them, because
a token is a broker fact and the core never sees one.

Two rules here come from the reference engine having been bitten:

* **The master goes stale daily, and again at 08:00.** Brokers publish the new
  day's file around 08:00 IST with that day's new weekly strikes, so a copy
  downloaded at 07:40 after an early restart is already wrong by 08:01.
* **Index symbols contain spaces.** "NIFTY 50" cannot be an engine instrument
  id, which appears in log lines and journal keys. The id is normalised; the
  broker's own spelling stays on ``trading_symbol``.
* **Calendar spreads must not be loaded as futures.** Some feeds publish an
  index calendar spread as an ordinary future whose symbol jams two expiry
  tokens together, e.g. ``NIFTY26MAY26JULFUT``. Loaded, it poisons every
  lookup for that underlying's near-month future, and the symptom is a quote
  fetch failing far away from the cause. Zerodha's master is clean today; the
  guard is there so a future feed cannot quietly reintroduce it.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from re import compile as compile_pattern
from typing import Final
from zoneinfo import ZoneInfo

from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.symbol import SymbolInfo

#: The hour a broker's new instrument master appears, with that day's new
#: weekly strikes. A file downloaded before it is stale once it passes.
MASTER_PUBLISHED_AT: Final = time(8, 0)

#: No legitimate single-leg future carries two month tokens. The shape itself
#: is the tell.
CALENDAR_SPREAD = compile_pattern(r"^[A-Z]+\d{2}[A-Z]{3}\d{2}[A-Z]{3}FUT$")

#: Kite's exchange column names a *segment* — NFO is NSE's derivatives
#: segment, not a separate venue. The engine models the venue, so the two are
#: separated here, at the adapter boundary.
EXCHANGE_SEGMENTS: Final[dict[str, tuple[str, Segment]]] = {
    "NSE": ("NSE", Segment.EQUITY),
    "NFO": ("NSE", Segment.FNO),
    "CDS": ("NSE", Segment.CURRENCY),
    "BSE": ("BSE", Segment.EQUITY),
    "BFO": ("BSE", Segment.FNO),
    "BCD": ("BSE", Segment.CURRENCY),
    "MCX": ("MCX", Segment.COMMODITY),
}

_OPTION_TYPES: Final[dict[str, OptionType]] = {"CE": OptionType.CALL, "PE": OptionType.PUT}


def canonical_symbol(broker_symbol: str) -> str:
    """A broker symbol reduced to something usable as an identifier.

    Zerodha writes index symbols with spaces -- "NIFTY 50", "NIFTY BANK" --
    and an engine instrument id must not contain whitespace: it appears in log
    lines, journal keys and correlation strings, where a space makes it
    unparseable.

    The broker's own spelling is not lost. It stays on the instrument as
    ``trading_symbol``, which is what the adapter sends back to the broker.
    """
    return "_".join(broker_symbol.split())


@dataclass(frozen=True, slots=True)
class InstrumentCatalogue:
    """Instruments, and the broker tokens that address them.

    The token map lives here rather than on the instrument: a token is a
    broker's private identifier, and the engine's own model must not carry one
    or the same instrument on two brokers becomes two instruments.
    """

    instruments: tuple[Instrument, ...] = field(default_factory=tuple)
    tokens: dict[InstrumentId, int] = field(default_factory=dict)
    #: Rows the parser refused, with the reason. Surfaced rather than swallowed:
    #: a master that silently lost a third of its rows looks like a working
    #: master.
    skipped: tuple[tuple[str, str], ...] = field(default_factory=tuple)

    def token_for(self, instrument: InstrumentId) -> int | None:
        return self.tokens.get(instrument)

    def __len__(self) -> int:
        return len(self.instruments)


def is_stale(
    downloaded_at: datetime | None,
    now: datetime,
    *,
    timezone: ZoneInfo,
    published_at: time = MASTER_PUBLISHED_AT,
) -> bool:
    """Whether a downloaded master needs replacing.

    Stale if it is from an earlier day, or from today but downloaded before
    the broker published that day's file.
    """
    if downloaded_at is None:
        return True
    local_now = now.astimezone(timezone)
    local_downloaded = downloaded_at.astimezone(timezone)
    if local_downloaded.date() < local_now.date():
        return True
    cutoff = datetime.combine(local_now.date(), published_at, tzinfo=timezone)
    return local_now >= cutoff and local_downloaded < cutoff


def parse_instruments(
    csv_text: str,
    exchanges: dict[str, Exchange],
    symbols: dict[str, SymbolInfo] | None = None,
    *,
    exercise_style: ExerciseStyle = ExerciseStyle.EUROPEAN,
    settlement_type: SettlementType = SettlementType.CASH,
) -> InstrumentCatalogue:
    """Parse Kite's instrument CSV into canonical instruments.

    ``exchanges`` supplies the venues the engine knows about; rows for a venue
    it does not model are skipped rather than invented, because an instrument
    whose calendar and currency are guessed produces a plausible, wrong trading
    day.

    ``symbols`` supplies per-underlying knowledge the master does not carry:
    the contract multiplier and the exchange freeze limit. Both are keyed by
    the underlying, so every option and future on CRUDEOIL inherits its
    hundred-barrel multiplier. Without it a commodity P&L is wrong by two
    orders of magnitude and still looks plausible.
    """
    if not csv_text.startswith("instrument_token,"):
        raise DomainError(
            "this is not a Kite instrument master; it does not begin with instrument_token"
        )

    instruments: list[Instrument] = []
    tokens: dict[InstrumentId, int] = {}
    skipped: list[tuple[str, str]] = []

    known_symbols = symbols or {}
    for row in csv.DictReader(io.StringIO(csv_text)):
        symbol = (row.get("tradingsymbol") or "").strip()
        try:
            parsed = _parse_row(row, exchanges, known_symbols, exercise_style, settlement_type)
        except DomainError as error:
            skipped.append((symbol, str(error)))
            continue
        if parsed is None:
            continue
        instrument, token = parsed
        instruments.append(instrument)
        tokens[instrument.id] = token

    return InstrumentCatalogue(
        instruments=tuple(instruments), tokens=tokens, skipped=tuple(skipped)
    )


def _parse_row(
    row: dict[str, str],
    exchanges: dict[str, Exchange],
    symbols: dict[str, SymbolInfo],
    exercise_style: ExerciseStyle,
    settlement_type: SettlementType,
) -> tuple[Instrument, int] | None:
    symbol = (row.get("tradingsymbol") or "").strip()
    if not symbol:
        raise DomainError("row has no trading symbol")

    kite_exchange = (row.get("exchange") or "").strip().upper()
    mapping = EXCHANGE_SEGMENTS.get(kite_exchange)
    if mapping is None:
        return None  # a segment the engine does not model
    exchange_code, segment = mapping

    exchange = exchanges.get(exchange_code)
    if exchange is None:
        return None  # a venue the operator has not configured

    instrument_type = (row.get("instrument_type") or "").strip().upper()
    kite_segment = (row.get("segment") or "").strip().upper()

    if instrument_type == "FUT" and CALENDAR_SPREAD.match(symbol):
        raise DomainError(
            "calendar spread published as a future; loading it would poison "
            "near-month lookups for this underlying"
        )

    kind = _kind_for(instrument_type, kite_segment)
    if kind is None:
        return None

    if kind is InstrumentKind.INDEX:
        # An index is priced and subscribed to, never routed, so it belongs to
        # whichever segment the venue actually derives from it.
        segment = Segment.FNO if exchange.trades(Segment.FNO) else Segment.EQUITY

    token = _integer(row, "instrument_token")
    expiry = _expiry(row.get("expiry"))
    strike = _decimal(row.get("strike"))
    tick_size = _decimal(row.get("tick_size")) or Decimal("0.05")
    lot_size = _integer(row, "lot_size", default=1) or 1

    underlying: InstrumentId | None = None
    underlying_name = (row.get("name") or "").strip()
    if kind in (InstrumentKind.FUTURE, InstrumentKind.OPTION):
        if not underlying_name:
            raise DomainError("a derivative row carries no underlying name")
        underlying = InstrumentId(f"{exchange_code}:{canonical_symbol(underlying_name)}")

    # Per-underlying knowledge the master does not carry. Keyed by the
    # underlying so every option and future on it inherits the same contract
    # multiplier and freeze limit.
    info = symbols.get(underlying_name or symbol)
    multiplier = info.contract_multiplier if info else Decimal(1)
    freeze_quantity = info.freeze_limit_quantity if info else None

    instrument = Instrument(
        id=InstrumentId(f"{exchange_code}:{canonical_symbol(symbol)}"),
        exchange=exchange,
        segment=segment,
        kind=kind,
        trading_symbol=symbol,
        lot_size=lot_size,
        tick_size=tick_size,
        multiplier=multiplier,
        freeze_quantity=freeze_quantity,
        underlying=underlying,
        expiry=expiry,
        strike=strike if kind is InstrumentKind.OPTION else None,
        option_type=_OPTION_TYPES.get(instrument_type) if kind is InstrumentKind.OPTION else None,
        exercise_style=exercise_style if kind is InstrumentKind.OPTION else None,
        settlement_type=settlement_type if kind is InstrumentKind.OPTION else None,
    )
    return instrument, token


def _kind_for(instrument_type: str, kite_segment: str) -> InstrumentKind | None:
    if kite_segment == "INDICES":
        return InstrumentKind.INDEX
    if instrument_type in _OPTION_TYPES:
        return InstrumentKind.OPTION
    if instrument_type == "FUT":
        return InstrumentKind.FUTURE
    if instrument_type == "EQ":
        return InstrumentKind.EQUITY
    return None


def _integer(row: dict[str, str], key: str, *, default: int | None = None) -> int:
    raw = (row.get(key) or "").strip()
    if not raw:
        if default is None:
            raise DomainError(f"row has no {key}")
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise DomainError(f"{key} {raw!r} is not a whole number") from error


def _decimal(raw: str | None) -> Decimal | None:
    """Kite writes numbers as text. Parsed exactly, never through a float.

    The reference engine rounds strikes to whole numbers via a double. That
    loses a fractional strike and puts a float in a price path; here the value
    is kept as written.
    """
    text = (raw or "").strip()
    if not text:
        return None
    try:
        value = Decimal(text)
    except ArithmeticError as error:
        raise DomainError(f"{text!r} is not a number") from error
    return value if value > 0 else None


def _expiry(raw: str | None) -> date | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError as error:
        raise DomainError(f"expiry {text!r} is not a date") from error


def next_refresh_after(now: datetime, *, timezone: ZoneInfo) -> datetime:
    """When the next master becomes available, for scheduling a refresh."""
    local_now = now.astimezone(timezone)
    today = datetime.combine(local_now.date(), MASTER_PUBLISHED_AT, tzinfo=timezone)
    return today if local_now < today else today + timedelta(days=1)
