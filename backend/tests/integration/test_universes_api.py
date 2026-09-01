"""The stock-universe endpoints, against a real database.

A universe is a named list a strategy can draw from. Nothing in the engine
resolves one yet, so these tests are about the endpoints and about the one
rule that keeps the list honest: a member has to be a symbol the engine can
price.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import universes
from garuda.core.clock import ReplayClock
from garuda.persistence import models

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 9, 1, 4, 0, tzinfo=dt.UTC)


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    envelope.install(app)
    app.include_router(universes.build(session_factory, ReplayClock(NOW)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as open_client:
        yield open_client


@pytest.fixture
async def curated(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """NSE exists, and three symbols are curated on the Symbols page."""
    async with session_factory() as session:
        session.add(
            models.ExchangesRow(
                exchange_code="NSE",
                exchange_name="NSE",
                currency="INR",
                segments="EQUITY",
                market_open=dt.time(9, 15),
                market_close=dt.time(15, 30),
            )
        )
        for symbol in ("RELIANCE", "TCS", "INFY"):
            session.add(models.SymbolsRow(symbol=symbol, exchange="NSE", strike_gap=50))
        await session.commit()


async def create(client: httpx.AsyncClient, **body: Any) -> httpx.Response:
    return await client.post("/api/engine/universes", json={"name": "Large caps", **body})


class TestReading:
    async def test_creates_one_and_reads_it_back(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        response = await create(client, members=["RELIANCE", "TCS"])

        assert response.status_code == 200
        created = response.json()["data"]
        assert created["universeId"] > 0
        assert created["name"] == "Large caps"
        assert created["universeType"] == "CUSTOM"
        assert created["source"] == "MANUAL"
        assert created["isActive"] is True
        assert created["members"] == ["RELIANCE", "TCS"]

    async def test_the_list_omits_members(self, client: httpx.AsyncClient, curated: None) -> None:
        """The list page shows headers; fetching every member of every universe
        to draw a table of names would be work nobody asked for."""
        await create(client, members=["RELIANCE"])

        rows = (await client.get("/api/engine/universes")).json()["data"]

        assert len(rows) == 1
        assert "members" not in rows[0]

    async def test_lists_alphabetically(self, client: httpx.AsyncClient, curated: None) -> None:
        await create(client, name="Small caps")
        await create(client, name="Large caps")

        rows = (await client.get("/api/engine/universes")).json()["data"]

        assert [row["name"] for row in rows] == ["Large caps", "Small caps"]

    async def test_active_lists_only_the_active_ones(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        await create(client, name="On")
        await create(client, name="Off", isActive=False)

        rows = (await client.get("/api/engine/universes/active")).json()["data"]

        assert [row["name"] for row in rows] == ["On"]

    async def test_active_is_not_swallowed_by_the_id_route(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        """`/active` and `/{universe_id}` are the same shape. Wrong order and
        this would 404 looking for a universe called "active"."""
        assert (await client.get("/api/engine/universes/active")).status_code == 200

    async def test_an_unknown_id_is_a_404(self, client: httpx.AsyncClient) -> None:
        assert (await client.get("/api/engine/universes/999")).status_code == 404


class TestMembers:
    async def test_a_member_that_is_not_a_curated_symbol_is_refused(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        """The list would look complete and trade short: a strategy drawing on
        it cannot price a symbol the engine does not know."""
        response = await create(client, members=["RELIANCE", "NOTLISTED"])

        assert response.status_code == 400
        assert "NOTLISTED" in response.json()["message"]
        assert (await client.get("/api/engine/universes")).json()["data"] == []

    async def test_members_are_upper_cased_and_deduplicated(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        response = await create(client, members=["reliance", "RELIANCE", " tcs ", ""])

        assert response.json()["data"]["members"] == ["RELIANCE", "TCS"]

    async def test_an_update_replaces_the_whole_list(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        """The Console sends the list it wants, not a diff."""
        created = (await create(client, members=["RELIANCE", "TCS"])).json()["data"]

        response = await client.put(
            f"/api/engine/universes/{created['universeId']}", json={"members": ["INFY"]}
        )

        assert response.json()["data"]["members"] == ["INFY"]

    async def test_an_empty_list_clears_the_members(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        created = (await create(client, members=["RELIANCE"])).json()["data"]

        await client.put(f"/api/engine/universes/{created['universeId']}", json={"members": []})

        assert (await client.get(f"/api/engine/universes/{created['universeId']}")).json()["data"][
            "members"
        ] == []

    async def test_not_sending_members_leaves_them_alone(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        created = (await create(client, members=["RELIANCE"])).json()["data"]

        await client.put(f"/api/engine/universes/{created['universeId']}", json={"name": "Renamed"})

        row = (await client.get(f"/api/engine/universes/{created['universeId']}")).json()["data"]
        assert row["name"] == "Renamed"
        assert row["members"] == ["RELIANCE"]

    async def test_a_rejected_member_list_leaves_the_old_one_in_place(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        created = (await create(client, members=["RELIANCE"])).json()["data"]

        response = await client.put(
            f"/api/engine/universes/{created['universeId']}", json={"members": ["NOPE"]}
        )

        assert response.status_code == 400
        assert (await client.get(f"/api/engine/universes/{created['universeId']}")).json()["data"][
            "members"
        ] == ["RELIANCE"]


class TestWriting:
    async def test_the_type_and_source_default_together(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        custom = (await create(client, name="Custom")).json()["data"]
        indexed = (await create(client, name="Nifty 50", universeType="PREDEFINED_INDEX")).json()[
            "data"
        ]

        assert (custom["universeType"], custom["source"]) == ("CUSTOM", "MANUAL")
        assert (indexed["universeType"], indexed["source"]) == ("PREDEFINED_INDEX", "NSE_CSV")

    @pytest.mark.parametrize(("field", "bad"), [("universeType", "WATCHLIST"), ("source", "FTP")])
    async def test_a_type_or_source_that_is_not_one_is_refused(
        self, client: httpx.AsyncClient, curated: None, field: str, bad: str
    ) -> None:
        assert (await create(client, **{field: bad})).status_code == 400

    async def test_an_exchange_that_does_not_exist_is_refused(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        assert (await create(client, exchange="XSE")).status_code == 404

    async def test_two_universes_with_one_name_are_refused(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        await create(client, name="Large caps")

        assert (await create(client, name="Large caps")).status_code == 409

    async def test_renaming_onto_another_name_is_refused(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        await create(client, name="Large caps")
        other = (await create(client, name="Small caps")).json()["data"]

        response = await client.put(
            f"/api/engine/universes/{other['universeId']}", json={"name": "Large caps"}
        )

        assert response.status_code == 409

    async def test_renaming_to_its_own_name_is_fine(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        created = (await create(client, name="Large caps")).json()["data"]

        response = await client.put(
            f"/api/engine/universes/{created['universeId']}", json={"name": "Large caps"}
        )

        assert response.status_code == 200

    async def test_deactivating_one_keeps_it(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        created = (await create(client, members=["RELIANCE"])).json()["data"]

        await client.put(f"/api/engine/universes/{created['universeId']}", json={"isActive": False})

        assert (await client.get("/api/engine/universes/active")).json()["data"] == []
        assert len((await client.get("/api/engine/universes")).json()["data"]) == 1

    async def test_deletes_one_and_its_members(
        self, client: httpx.AsyncClient, curated: None
    ) -> None:
        created = (await create(client, members=["RELIANCE", "TCS"])).json()["data"]

        assert (
            await client.delete(f"/api/engine/universes/{created['universeId']}")
        ).status_code == 200
        assert (await client.get("/api/engine/universes")).json()["data"] == []
        # And the name is free again, which it would not be if the header row
        # had survived.
        assert (await create(client, name="Large caps")).status_code == 200

    async def test_deleting_an_unknown_id_is_a_404(self, client: httpx.AsyncClient) -> None:
        assert (await client.delete("/api/engine/universes/999")).status_code == 404
