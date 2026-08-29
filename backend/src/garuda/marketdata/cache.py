"""Caching the raw instrument master on disk.

The master is a large CSV and a broker publishes one a day. Keeping the raw
text means a restart at eleven does not re-download it, and — more useful — the
exact bytes the engine parsed are still there when a strike selection later
looks wrong.

Raw rather than parsed on purpose: a parsed cache is only readable by the
version that wrote it, and the first thing anyone wants when a symbol is
missing is the file the broker actually sent.

The download time is written beside the file rather than taken from its
modification time. A file's mtime is real wall-clock time, and the engine reads
time through the Clock: a replay would otherwise compare a simulated instant
against a real timestamp and conclude that a cache written moments ago is from
the future.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from garuda.domain.calendar import require_aware
from garuda.domain.errors import DomainError
from garuda.protocols.clock import Clock


@dataclass(frozen=True, slots=True)
class CachedMaster:
    """One broker's instrument master, as downloaded."""

    text: str
    downloaded_at: datetime
    source: str

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


class InstrumentCache:
    """Raw masters on disk, one file per broker."""

    def __init__(self, directory: Path, clock: Clock) -> None:
        self._directory = directory
        self._clock = clock

    def path_for(self, broker: str) -> Path:
        if not broker or "/" in broker or broker != broker.strip():
            raise DomainError(f"{broker!r} is not usable as a file name")
        return self._directory / f"{broker}_instruments.csv"

    def metadata_path_for(self, broker: str) -> Path:
        return self.path_for(broker).with_suffix(".meta.json")

    def read(self, broker: str) -> CachedMaster | None:
        """The cached master, or None when there is not one.

        A master whose recorded download time is missing or unreadable is
        treated as absent rather than as very old: without a time there is no
        way to tell whether it is today's, and re-downloading costs one request
        while trusting it costs a day of wrong strikes.
        """
        path = self.path_for(broker)
        metadata = self.metadata_path_for(broker)
        if not path.exists() or not metadata.exists():
            return None
        try:
            downloaded_at = datetime.fromisoformat(
                json.loads(metadata.read_text(encoding="utf-8"))["downloaded_at"]
            )
        except (ValueError, KeyError, TypeError):
            return None
        return CachedMaster(
            text=path.read_text(encoding="utf-8"),
            downloaded_at=require_aware(downloaded_at),
            source=str(path),
        )

    def write(self, broker: str, text: str) -> CachedMaster:
        """Replace the cached master.

        Written to a temporary file and moved into place, so a process killed
        mid-write leaves the previous master intact rather than a truncated one
        that parses to half a universe.
        """
        if not text.strip():
            raise DomainError(f"{broker}: refusing to cache an empty instrument master")
        self._directory.mkdir(parents=True, exist_ok=True)
        path = self.path_for(broker)
        temporary = path.with_suffix(".csv.partial")
        temporary.write_text(text, encoding="utf-8")
        temporary.replace(path)

        downloaded_at = self._clock.now()
        # Written after the master, so a crash between the two leaves a file
        # with no recorded time, which reads as no cache at all.
        self.metadata_path_for(broker).write_text(
            json.dumps({"downloaded_at": downloaded_at.isoformat()}), encoding="utf-8"
        )
        return CachedMaster(text=text, downloaded_at=downloaded_at, source=str(path))

    def clear(self, broker: str) -> None:
        self.path_for(broker).unlink(missing_ok=True)
        self.metadata_path_for(broker).unlink(missing_ok=True)
