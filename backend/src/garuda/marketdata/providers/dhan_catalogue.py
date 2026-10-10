"""Dhan's names for the instruments the engine knows.

A :class:`ProviderTokens` implementation, so nothing above it knows Dhan names
an instrument by a *pair* -- an exchange segment and a security id -- rather
than by a single number the way Kite does. The token is written
``NSE_FNO:44234``, and this is the only module that takes it apart.

Segment matters beyond addressing: an index subscribes in a different mode and
decodes from a different packet, and a history request carries a derived
`instrument` kind. Those need the master row, not just the id, so the row is
kept alongside and reachable by instrument.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.instrument import canonical_symbol as reduce_symbol
from garuda.marketdata.providers.dhan_master import DhanInstrument
from garuda.marketdata.providers.dhan_packets import INDEX_SEGMENT, SEGMENT_NUMBERS
from garuda.marketdata.providers.dhan_rest import instrument_kind

logger = logging.getLogger(__name__)

PROVIDER = "dhan"


def token_of(segment: str, security_id: str) -> str:
    return f"{segment}:{security_id}"


def split_token(token: str) -> tuple[str, str] | None:
    segment, _, security_id = token.partition(":")
    if not segment or not security_id:
        return None
    return segment, security_id


class DhanCatalogue:
    """One loaded scrip master, as a translation.

    Immutable once built. The master is reloaded by replacing this whole
    object, so no consumer can be holding half of yesterday's and half of
    today's.
    """

    def __init__(self, instruments: Iterable[DhanInstrument]) -> None:
        forward: dict[InstrumentId, DhanInstrument] = {}
        reverse: dict[tuple[int, int], InstrumentId] = {}
        unknown_segments: set[str] = set()

        for row in instruments:
            # Dhan publishes an index under its spaced name, "NIFTY 50", which
            # is not an instrument id. Reduced by the domain's rule rather than
            # this module's, because the broker master the engine matches
            # against reduces it by the same one -- and an index the two spell
            # differently quotes and never ticks.
            symbol = reduce_symbol(row.trading_symbol)
            # Checked *after* reducing: a symbol of nothing but spaces is
            # truthy before and empty after, and would otherwise be indexed
            # under the bare exchange prefix.
            if not symbol or not row.exchange:
                continue
            try:
                instrument = InstrumentId(f"{row.exchange}:{symbol}")
            except DomainError as error:
                # One unusable row must not cost the other eighty thousand.
                logger.warning("dhan: skipping %r: %s", row.trading_symbol, error)
                continue
            forward[instrument] = row

            number = SEGMENT_NUMBERS.get(row.segment)
            if number is None:
                unknown_segments.add(row.segment)
                continue
            try:
                reverse[(number, int(row.security_id))] = instrument
            except ValueError:
                logger.warning(
                    "dhan: %s has a non-numeric security id %r", instrument, row.security_id
                )

        self._forward: Mapping[InstrumentId, DhanInstrument] = forward
        self._reverse: Mapping[tuple[int, int], InstrumentId] = reverse

        if unknown_segments:
            # Not fatal: a segment this engine does not trade is ordinary. It
            # is logged because an instrument that quotes but never ticks is
            # otherwise indistinguishable from an illiquid one.
            logger.warning(
                "dhan: %d segments are not in the feed's segment table and cannot be "
                "subscribed: %s",
                len(unknown_segments),
                ", ".join(sorted(unknown_segments)),
            )

    @property
    def provider(self) -> str:
        return PROVIDER

    def __len__(self) -> int:
        return len(self._forward)

    def details_for(self, instrument: InstrumentId) -> DhanInstrument | None:
        return self._forward.get(instrument)

    def token_for(self, instrument: InstrumentId) -> str | None:
        row = self._forward.get(instrument)
        if row is None:
            return None
        return token_of(row.segment, row.security_id)

    def instrument_for(self, token: str) -> InstrumentId | None:
        parts = split_token(token)
        if parts is None:
            return None
        segment, security_id = parts
        number = SEGMENT_NUMBERS.get(segment)
        if number is None:
            return None
        try:
            return self._reverse.get((number, int(security_id)))
        except ValueError:
            return None

    def by_wire(self, segment_number: int, security_id: int) -> InstrumentId | None:
        """What the feed's packet header addresses, as an instrument."""
        return self._reverse.get((segment_number, security_id))

    def segment_number_for(self, instrument: InstrumentId) -> int | None:
        row = self._forward.get(instrument)
        if row is None:
            return None
        return SEGMENT_NUMBERS.get(row.segment)

    def is_index(self, instrument: InstrumentId) -> bool:
        row = self._forward.get(instrument)
        return row is not None and (
            row.is_index or SEGMENT_NUMBERS.get(row.segment) == INDEX_SEGMENT
        )

    def history_kind(self, instrument: InstrumentId) -> str | None:
        """The `instrument` field a history request carries for this one."""
        row = self._forward.get(instrument)
        if row is None:
            return None
        return instrument_kind(
            segment=row.segment,
            option_type=row.option_type,
            is_future=row.is_future,
            is_index=row.is_index,
        )

    def group_by_segment(
        self, instruments: Sequence[InstrumentId]
    ) -> dict[str, list[InstrumentId]]:
        """Dhan's quote call is posted per segment, so callers need this split.

        Instruments the master does not list are left out, not grouped under
        an empty segment: a quote request for an unknown security id is
        refused for the whole batch, not just for that one.
        """
        grouped: dict[str, list[InstrumentId]] = {}
        for instrument in instruments:
            row = self._forward.get(instrument)
            if row is None:
                logger.warning("dhan does not list %s; no quote for it", instrument)
                continue
            grouped.setdefault(row.segment, []).append(instrument)
        return grouped


#: What a Dhan adapter reads before the master has been downloaded. Every
#: lookup on it answers "not listed", which at that moment is the truth.
EMPTY = DhanCatalogue([])
