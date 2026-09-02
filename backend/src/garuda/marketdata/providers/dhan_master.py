"""Reading Dhan's scrip master.

Dhan publishes a CSV of every instrument it lists, under its own names. The
job here is the same one the reference market-data service does in
`DhanInstruments.convertToCanonicalCSV`: rebuild the **canonical** trading
symbol from the contract's own fields, so the row can be matched against the
instrument the engine already knows, and record Dhan's `(segment, securityId)`
against it.

The symbol grammar is ported as it stands, because it is a convention rather
than anything derivable:

    future            UND + YY + MMM + "FUT"          NIFTY26JUNFUT
    monthly option    UND + YY + MMM + STRIKE + CE|PE CRUDEOIL26JUN8600CE
    weekly option     UND + YY + M + DD + STRIKE + CE|PE   NIFTY2660921100CE

where `M` for a weekly is 1-9 for January to September and O, N, D for the
last three months — because a two-digit month would be ambiguous against the
day that follows it.

Which options are monthly cannot be read off a row: it is **the last expiry in
that underlying's calendar month**, so the file is read twice, once to find
those and once to build. Getting this wrong does not fail loudly — it produces
a symbol nothing matches, and that instrument silently never ticks.
"""

from __future__ import annotations

import csv
import io
import logging
from dataclasses import dataclass
from datetime import date

import httpx

from garuda.domain.errors import DomainError

logger = logging.getLogger(__name__)

MONTHS_3 = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")

#: Weekly-expiry month code: 1-9 for Jan-Sep, then O, N, D.
MONTH_CODE = ("1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D")

#: Dhan's segment string per exchange and segment code. The index segment is
#: the one that matters most: it decides both how a packet is decoded and which
#: mode the instrument is subscribed in.
INDEX_SEGMENT = "IDX_I"

#: Dhan's detailed scrip master. Public, no authentication -- which is why a
#: catalogue can be loaded before anyone has logged in. A vendor endpoint, so
#: it lives here rather than in a settings row.
MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv"

#: The file is tens of megabytes; the default ten seconds is not enough.
MASTER_TIMEOUT_SECONDS = 120.0


@dataclass(frozen=True, slots=True)
class DhanInstrument:
    """One row of Dhan's master, in the terms the engine needs."""

    security_id: str
    segment: str
    exchange: str
    trading_symbol: str
    underlying: str
    lot_size: int
    expiry: date | None = None
    strike: int | None = None
    is_index: bool = False
    #: "CE", "PE", or empty. Carried rather than read back out of the trading
    #: symbol: a history request needs it, and recovering it from the symbol
    #: means trusting that no underlying's name happens to end in CE or PE.
    option_type: str = ""
    is_future: bool = False


async def download_master(client: httpx.AsyncClient, *, url: str = MASTER_URL) -> str:
    """Fetch the day's master.

    Returned as text and handed on unparsed, so a parse failure later can be
    diagnosed against exactly the bytes Dhan sent.
    """
    response = await client.get(url, timeout=MASTER_TIMEOUT_SECONDS)
    response.raise_for_status()
    body = response.text
    if not body.strip():
        raise DomainError("the Dhan scrip master came back empty")
    return body


def _first(*values: str) -> str:
    for value in values:
        if value:
            return value
    return ""


def _get(row: dict[str, str], *names: str) -> str:
    for name in names:
        value = row.get(name)
        if value:
            return value.strip()
    return ""


def _expiry(raw: str) -> date | None:
    """Dhan writes an expiry several ways; only the date part is wanted."""
    if not raw:
        return None
    text = raw.strip().split(" ")[0]
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _strike(raw: str) -> int | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return int(value) if value > 0 else None


def _lot_size(raw: str) -> int:
    try:
        return max(1, int(float(raw)))
    except (TypeError, ValueError):
        return 1


def segment_for(exchange: str, segment_code: str, *, is_index: bool) -> str:
    """Dhan's ExchangeSegment string for a row."""
    if is_index:
        return INDEX_SEGMENT
    exchange = exchange.upper()
    code = segment_code.upper()
    if exchange == "NSE":
        if code == "D":
            return "NSE_FNO"
        if code == "C":
            return "NSE_CURRENCY"
        return "NSE_EQ"
    if exchange == "BSE":
        if code == "D":
            return "BSE_FNO"
        if code == "C":
            return "BSE_CURRENCY"
        return "BSE_EQ"
    if exchange == "MCX":
        return "MCX_COMM"
    return f"{exchange}_{code}"


def canonical_symbol(
    underlying: str,
    expiry: date,
    *,
    option_type: str,
    is_future: bool,
    strike: int | None,
    monthly: bool,
) -> str:
    """The trading symbol the engine knows this contract by."""
    und = underlying.upper()
    year = f"{expiry.year % 100:02d}"
    if is_future:
        return f"{und}{year}{MONTHS_3[expiry.month - 1]}FUT"
    if strike is None or not option_type:
        return ""
    code = (
        f"{year}{MONTHS_3[expiry.month - 1]}"
        if monthly
        else f"{year}{MONTH_CODE[expiry.month - 1]}{expiry.day:02d}"
    )
    return f"{und}{code}{strike}{option_type}"


def _monthly_expiries(rows: list[dict[str, str]]) -> dict[tuple[str, int, int], date]:
    """The last option expiry in each underlying's calendar month.

    That, and only that, uses the monthly grammar. It cannot be read off a
    single row, which is why the file is read twice.
    """
    latest: dict[tuple[str, int, int], date] = {}
    for row in rows:
        option_type = _get(row, "SEM_OPTION_TYPE", "OPTION_TYPE").upper()
        if option_type not in ("CE", "PE"):
            continue
        underlying = _get(row, "UNDERLYING_SYMBOL")
        expiry = _expiry(_get(row, "SEM_EXPIRY_DATE", "SM_EXPIRY_DATE"))
        if not underlying or expiry is None:
            continue
        key = (underlying.upper(), expiry.year, expiry.month)
        if key not in latest or expiry > latest[key]:
            latest[key] = expiry
    return latest


def parse_master(csv_text: str) -> list[DhanInstrument]:
    """Every instrument Dhan lists, with the symbol the engine knows it by.

    A row that cannot be read is skipped and counted rather than taking the
    load down: one malformed line in a file of a hundred thousand must not
    cost the other ninety-nine thousand.
    """
    reader = csv.DictReader(io.StringIO(csv_text))
    rows = [{(k or "").strip().upper(): (v or "") for k, v in row.items()} for row in reader]
    if not rows:
        logger.error("Dhan scrip master has no rows")
        return []

    monthly = _monthly_expiries(rows)
    out: list[DhanInstrument] = []
    skipped = 0

    for row in rows:
        try:
            security_id = _get(row, "SEM_SMST_SECURITY_ID", "SECURITY_ID")
            if not security_id:
                continue

            exchange = _get(row, "SEM_EXM_EXCH_ID", "EXCH_ID").upper()
            segment_code = _get(row, "SEM_SEGMENT", "SEGMENT").upper()
            kind = _get(
                row,
                "SEM_EXCH_INSTRUMENT_TYPE",
                "INSTRUMENT_TYPE",
                "SEM_INSTRUMENT_NAME",
                "INSTRUMENT",
            ).upper()
            option_type = _get(row, "SEM_OPTION_TYPE", "OPTION_TYPE").upper()
            exchange_symbol = _get(row, "SEM_TRADING_SYMBOL")
            symbol_name = _get(row, "SYMBOL_NAME", "SM_SYMBOL_NAME")
            display_name = _get(row, "SEM_CUSTOM_SYMBOL", "DISPLAY_NAME")
            underlying = _get(row, "UNDERLYING_SYMBOL")
            lot_size = _lot_size(_get(row, "SEM_LOT_UNITS", "LOT_SIZE"))
            strike = _strike(_get(row, "SEM_STRIKE_PRICE", "STRIKE_PRICE"))
            expiry = _expiry(_get(row, "SEM_EXPIRY_DATE", "SM_EXPIRY_DATE"))

            is_index = kind == "INDEX" or segment_code == "I" or "INDEX" in kind
            if is_index:
                trading_symbol = _first(exchange_symbol, display_name, symbol_name).upper()
                name = (underlying or trading_symbol).upper()
            else:
                name = _first(underlying, symbol_name).upper()
                is_option = option_type in ("CE", "PE")
                is_future = kind.startswith("FUT")
                trading_symbol = ""
                if (is_option or is_future) and expiry is not None:
                    # A future is always the monthly grammar; an option only
                    # when it is the last expiry of its month.
                    is_monthly = not is_option or expiry == monthly.get(
                        (name, expiry.year, expiry.month)
                    )
                    trading_symbol = canonical_symbol(
                        name,
                        expiry,
                        option_type=option_type,
                        is_future=is_future,
                        strike=strike,
                        monthly=is_monthly,
                    )
                if not trading_symbol:
                    trading_symbol = _first(exchange_symbol, symbol_name, display_name)
                trading_symbol = trading_symbol.upper()

            if not trading_symbol:
                trading_symbol = name
            if not trading_symbol:
                skipped += 1
                continue

            out.append(
                DhanInstrument(
                    security_id=security_id,
                    segment=segment_for(exchange, segment_code, is_index=is_index),
                    exchange=exchange,
                    trading_symbol=trading_symbol,
                    underlying=name or trading_symbol,
                    lot_size=lot_size,
                    expiry=expiry,
                    strike=strike,
                    is_index=is_index,
                    option_type=option_type if option_type in ("CE", "PE") else "",
                    is_future=kind.startswith("FUT"),
                )
            )
        except Exception:
            skipped += 1

    if skipped:
        logger.warning("Dhan scrip master: %d row(s) could not be read", skipped)
    logger.info("Dhan scrip master: %d instruments", len(out))
    return out
