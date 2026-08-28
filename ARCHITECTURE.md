# Garuda Engine — Architecture

**Status:** Draft v0.2 — backtesting removed by design (§1.1)
**Scope:** Design reference for the open-source Python trading engine.
**Audience:** Maintainer and prospective contributors.

---

## 1. Purpose

A venue-neutral, event-driven trading engine. Strategies are written against a
small stable interface; the engine handles market data, order routing, position
and P&L tracking, risk gating, and reconciliation.

**v1 ships:** Indian equities and F&O (NSE/BSE), commodities (MCX), plus a paper
broker.
**v1 is designed for, but does not ship:** US and other international venues.

### Non-goals

- **No backtester.** See §1.1 — this is a deliberate decision, not a missing
  feature.
- Not an HFT or latency-arbitrage system. Target is retail-to-HNI systematic
  trading at seconds-to-minutes granularity, not microseconds.
- Not a broker. No custody, no order matching.
- No strategy recommendations shipped in core.

### 1.1 Why there is no backtester

The engine ships no historical data loader, no backtest runner, and no
performance or equity-curve reporting. The reason is data quality, not
implementation difficulty:

- **Options history is largely unavailable.** Complete strike-and-expiry chains
  for Indian markets barely exist for earlier years, and what exists is partial.
- **Intraday OHLC is unreliable.** Broker candle APIs reconstruct bars from
  periodic snapshots rather than true tick aggregation, so intraday highs and
  lows are frequently wrong — precisely the values a stop-loss or breakout
  strategy depends on.
- **Vendor archives are inconsistent.** Formats, symbology and field semantics
  differ year to year within the same vendor's history, requiring a repair
  pipeline that is itself a source of silent error.

A backtester built on this data does not fail loudly. It produces confident,
specific, wrong numbers — and those get traded with real capital. Shipping one
would be the single most dangerous thing this project could do.

**The supported validation path is shadow mode against a live feed** (§10.1).

Deterministic replay of the engine's own journal is retained, but as test
infrastructure (§5.4, §10.2), not as a strategy research tool. Anyone who wants
a backtester with their own trusted data can build one as a plugin package
against the existing protocols; it will not live in core.

---

## 2. Design principles

1. **The venue is data, not code.** Currency, timezone, calendar, tick size, lot
   size, settlement type and exercise style are attributes of an `Exchange` or
   `Instrument` object. No `if exchange == "NSE"` anywhere in the core.
2. **One engine, two modes.** Shadow and live run identical engine code; only
   the routing target differs. Any divergence is a bug. The clock stays
   abstracted so the journal can be replayed deterministically in tests.
3. **Exact arithmetic everywhere.** `Decimal` only. A `float` in a money or
   price path is a defect, enforced by lint rule and test.
4. **State is derived from an event log.** Positions and P&L are folds over an
   append-only journal, never mutated in place. This yields deterministic
   replay, auditability and crash recovery from one mechanism.
5. **Strategies cannot reach the broker.** They emit intents. The engine
   translates, risk-gates, and routes.
6. **Extension without forking.** New brokers, strategies, feeds and stores are
   separate pip packages discovered via entry points.
7. **Fail closed.** On ambiguity — unknown order state, stale data, lost
   connection — stop trading and alert. Never guess in a money path.

---

## 3. Layers

```
┌──────────────────────────────────────────────────────────┐
│  Strategy layer          user code, plugin packages       │
│    Strategy protocol → emits Intent                       │
├──────────────────────────────────────────────────────────┤
│  Engine core             venue-neutral, no I/O            │
│    Router · RiskGate · OrderManager · PositionBook        │
│    Clock · EventBus · Journal                             │
├──────────────────────────────────────────────────────────┤
│  Domain model            Money · Instrument · Exchange    │
│    Order · Fill · Position · Calendar                     │
├──────────────────────────────────────────────────────────┤
│  Adapter layer           all venue-specific code          │
│    BrokerAdapter · MarketDataFeed · Store                 │
└──────────────────────────────────────────────────────────┘
```

Dependencies point downward only. The core imports no adapter. Adapters import
the domain model and implement protocols.

---

## 4. Domain model

### 4.1 Money and prices

```python
@dataclass(frozen=True, slots=True)
class Money:
    amount: Decimal
    currency: Currency          # ISO 4217
```

Rules:

- Arithmetic between different currencies raises. No implicit conversion.
- FX conversion happens only at an explicit reporting boundary, with a named
  rate source and timestamp recorded alongside the result.
- Prices are quantized to the instrument's tick size at the adapter boundary,
  with the rounding mode stated explicitly.
- A portfolio has one declared `base_currency`. Positions retain native
  currency; aggregation converts once, at the edge.

### 4.2 Exchange

Carries everything venue-specific so the core stays neutral:

```python
@dataclass(frozen=True)
class Exchange:
    code: str                      # "NSE", "MCX", "CME"
    timezone: ZoneInfo             # Asia/Kolkata, America/Chicago
    currency: Currency
    calendar: TradingCalendar      # holidays, sessions, half-days
    settlement: SettlementModel    # T+1, T+0, etc.
```

### 4.3 Instrument

```python
@dataclass(frozen=True)
class Instrument:
    id: InstrumentId               # canonical, engine-internal
    exchange: Exchange
    kind: InstrumentKind           # EQUITY FUTURE OPTION
    lot_size: int
    tick_size: Decimal
    multiplier: Decimal
    # derivatives
    underlying: InstrumentId | None
    expiry: date | None
    strike: Decimal | None
    option_type: OptionType | None      # CALL PUT
    exercise_style: ExerciseStyle | None # EUROPEAN AMERICAN
    settlement_type: SettlementType | None # CASH PHYSICAL
```

`exercise_style` and `settlement_type` are the two fields that let US equity
options coexist with Indian index options without special-casing. Do not omit
them because v1 is India-only — retrofitting them touches everything.

**Symbology.** `InstrumentId` is canonical and engine-owned. Adapters translate
to and from broker tokens or OCC/OSI symbols at their boundary. The core never
sees a broker-specific symbol string.

### 4.4 Trading day and sessions

`TradingCalendar` owns the concept of a trading day. It is **not** a calendar
date.

Concretely: MCX evening sessions run past 23:00 IST, and CME sessions open the
prior calendar evening in Chicago. Daily P&L rollover, EOD reconciliation and
"today's orders" must all key off `calendar.trading_day_for(instant)`, never
`datetime.date.today()`.

All timestamps are stored UTC-aware. Local time exists only for display and
calendar arithmetic. Naive datetimes are rejected at construction.

---

## 5. Core interfaces

These four are the project's public contract. Changing them is a breaking
release; everything else is internal.

### 5.1 BrokerAdapter

```python
class BrokerAdapter(Protocol):
    async def connect(self) -> None: ...
    async def place(self, req: OrderRequest) -> BrokerOrderId: ...
    async def modify(self, id: BrokerOrderId, changes: OrderChanges) -> None: ...
    async def cancel(self, id: BrokerOrderId) -> None: ...

    async def fetch_orders(self) -> Sequence[BrokerOrder]: ...
    async def fetch_positions(self) -> Sequence[BrokerPosition]: ...
    async def fetch_instruments(self) -> Sequence[Instrument]: ...

    def events(self) -> AsyncIterator[BrokerEvent]: ...
```

`BrokerEvent` is a closed union. It must include, from day one:

- `OrderAccepted` / `OrderRejected` / `OrderModified` / `OrderCancelled`
- `Fill` (partial and complete)
- **`Assignment`** — an inbound position change the engine did not initiate
- `MarginCall` / `AccountUpdate`
- `Disconnected` / `Resynced`

`Assignment` is non-negotiable structure even though NSE options are European
and it will never fire for v1 adapters. American-style exercise makes it a
routine event, and bolting it on later means reworking the position book.

**Adapter obligations:**

- Idempotency via client-generated order IDs; a retry must never double-send.
- Normalise broker errors into a shared taxonomy
  (`Retryable`, `Rejected`, `AuthExpired`, `RateLimited`, `Fatal`).
- Own reconnect and rate limiting internally; emit `Disconnected` when unsure.
- Never invent state. If unknown, say unknown.

### 5.2 Strategy

```python
class Strategy(Protocol):
    def on_start(self, ctx: Context) -> None: ...
    def on_bar(self, bar: Bar, ctx: Context) -> Iterable[Intent]: ...
    def on_tick(self, tick: Tick, ctx: Context) -> Iterable[Intent]: ...
    def on_fill(self, fill: Fill, ctx: Context) -> Iterable[Intent]: ...
    def on_stop(self, reason: StopReason, ctx: Context) -> None: ...
```

Synchronous by default. Most users are traders before they are async
programmers, and a blocking `await` in a callback would stall the loop. An
`AsyncStrategy` variant exists for advanced use.

Callbacks return **intents**, not orders — `Buy`, `Sell`, `Close`, `Replace`.
The engine sizes, prices, validates and routes them. This is what makes
strategies portable across venues and testable without a broker.

`Context` gives read-only access to positions, instruments, clock and
parameters. It exposes no method that places an order directly.

### 5.3 EventBus and Store

```python
class EventBus(Protocol):
    async def publish(self, event: Event) -> None: ...
    def subscribe(self, topic: Topic) -> AsyncIterator[Event]: ...

class Store(Protocol):
    async def append(self, events: Sequence[Event]) -> None: ...
    def replay(self, since: Checkpoint) -> AsyncIterator[Event]: ...
    async def snapshot(self, state: EngineState) -> Checkpoint: ...
```

Local default: in-process asyncio bus, SQLite store.
Production: Redis pub/sub, PostgreSQL. Strategy code is unaffected by the swap.

### 5.4 Clock

```python
class Clock(Protocol):
    def now(self) -> datetime: ...
    async def sleep_until(self, when: datetime) -> None: ...
```

`LiveClock` and `ReplayClock`. Nothing in the core calls `datetime.now()` or
`asyncio.sleep()` directly.

This exists for **testing, not strategy research**. It is what lets a recorded
journal be replayed byte-identically to verify engine correctness, and lets
crash-recovery and expiry-day behaviour be tested in seconds without waiting for
market hours. It is not a backtesting facility and is not exposed as one —
see §1.1.

---

## 6. Order flow

```
Strategy.on_bar → Intent
   ↓
Sizer            lots, tick rounding, notional limits
   ↓
RiskGate         pre-trade checks; may veto
   ↓
OrderManager     assigns client_order_id, journals, tracks state
   ↓
BrokerAdapter    translates to broker API
   ↓ (async)
BrokerEvent      fill / reject / assignment
   ↓
PositionBook     fold into positions and P&L
   ↓
Strategy.on_fill
```

**RiskGate** sits between every intent and every order. Checks are configured,
not coded into strategies: max position per instrument, max daily loss, max
order value, instrument allow-list, rate limiting, and a global kill switch.
It is the last line of defence against a strategy bug placing 1,000 orders in a
loop — treat it as a core safety component, not a feature.

**Order state machine.** Explicit and total:
`PENDING_NEW → NEW → PARTIALLY_FILLED → FILLED | CANCELLED | REJECTED | EXPIRED`,
with `PENDING_CANCEL` / `PENDING_REPLACE` as in-flight states. Every transition
is journalled. Unknown broker states map to `UNKNOWN` and halt trading on that
instrument rather than being guessed.

---

## 7. State, recovery and reconciliation

Positions and P&L are never stored as mutable rows. They are folds over the
journal, with periodic snapshots for fast startup.

**Startup sequence:**

1. Load latest snapshot; replay journal from that checkpoint.
2. Fetch broker truth: orders, positions, funds.
3. Diff engine state against broker state.
4. On mismatch — **halt, alert, do not trade.** Never auto-correct silently.
   Reconciliation breaks are almost always either a bug or a missed fill, and
   both are worse if traded through.
5. Resume streaming with a snapshot-then-delta protocol so no event is lost
   across the gap.

**Broker is always the source of truth** for positions and cash. Engine state is
a cache that must be provably consistent with it.

---

## 8. Concurrency

Single asyncio event loop owns all engine state — no locks, no shared mutable
state across threads. Adapters may use threads internally for blocking SDKs but
must marshal events onto the loop.

CPU-heavy strategy work (ML inference, large vector computation) belongs in a
process pool or an out-of-process service, invoked via a queue. Blocking the
loop delays every order in the system.

Backpressure is explicit: bounded queues with a documented policy per stream —
drop-oldest for ticks, never-drop for order events.

---

## 9. Extension model

```toml
[project.entry-points."garuda.brokers"]
zerodha = "garuda_zerodha:ZerodhaAdapter"

[project.entry-points."garuda.strategies"]
my_straddle = "my_pkg.straddle:ShortStraddle"
```

Third-party packages are discovered at runtime. Consequences:

- Private, client-specific work ships as a private package and never enters this
  repository.
- A US contributor can publish `garuda-ibkr` independently, on their own release
  schedule.
- When something cannot be expressed through the interfaces, the fix is to widen
  the interface upstream, never to fork the core.

Core carries the paper broker and a reference adapter only. Every other adapter
lives in its own repo with its own tests, so a broker API change breaks one
package rather than the release.

---

## 10. Validation and testing

### 10.1 Shadow mode

The supported way to validate a strategy before committing capital.

```
live market data feed
   ↓
Strategy                 real prices, real timing
   ↓ Intent
Sizer → RiskGate         identical to live
   ↓
Router ──────────────→   PaperBroker   (no capital at risk)
```

Everything upstream of the router is the same code path that runs live. The
strategy sees genuine spreads, genuine liquidity, genuine gaps and genuine
feed interruptions — the conditions that historical bar data cannot reproduce.

Rules:

- Simulated fills model spread, slippage and rejection explicitly, with the
  assumptions logged. A fill at mid is a lie and is not the default.
- Shadow runs journal exactly as live runs do, so a shadow session can be
  replayed and audited identically.
- Documentation recommends a minimum shadow period covering at least one
  expiry cycle before any live deployment.

Reported output is deliberately behavioural — intents, fills, rejections,
position states — not a headline return figure. The purpose is to answer
"does my logic behave as intended under real conditions", not "what would I
have earned".

### 10.2 Test matrix

| Layer | Method |
|---|---|
| Money and price arithmetic | Property-based (Hypothesis): no precision loss, no currency mixing |
| Order state machine | Exhaustive transition tests, including illegal transitions |
| Adapters | Recorded broker responses replayed; contract test suite every adapter must pass |
| Strategies | Shadow mode against live feed; paper broker with simulated fills, slippage and rejections |
| Engine | Deterministic journal replay — same journal in, same state out, byte-identical |
| Recovery | Kill the process mid-fill; assert reconciled state |

The **adapter contract test suite** is the key artefact for a contributor-driven
model. A new adapter is correct when it passes; you do not need broker access to
review it.

---

## 11. Repository layout

```
garuda-engine/
  src/garuda/
    domain/        money, instrument, exchange, calendar, order, position
    core/          engine, router, riskgate, ordermanager, positionbook, clock
    protocols/     BrokerAdapter, Strategy, EventBus, Store
    brokers/paper/ reference implementation
    store/         sqlite, postgres
    bus/           inprocess, redis
    testing/       contract suite, fixtures, fake clock
  docs/
  tests/
```

---

## 12. Phasing

**Phase 1 — skeleton.** Domain model, protocols, paper broker, one trivial
strategy running end-to-end with journal replay proving determinism. Ship
nothing else until this is clean; the seams must be proven before volume is
added.

**Phase 2 — one live broker.** Full order lifecycle, reconciliation, risk gate,
shadow mode. NSE equities and F&O.

**Phase 3 — MCX.** Forces the session and trading-day abstraction to be correct,
and validates that the venue model actually holds.

**Phase 4 — second broker.** The real test of the adapter interface. Expect to
revise it here; better now than after external adapters exist.

**Phase 5 — open the door.** Adapter contract suite, contributor docs, CLA. Only
now is outside contribution realistic.

---

## 13. Open questions

- Sizing: engine-owned policy or strategy-owned? Currently engine, via `Sizer`.
- Margin calculation: pluggable `MarginModel` per venue, or delegate entirely to
  broker-reported margin? Broker-reported for v1.
- Multi-account and multi-strategy netting on the same instrument — deferred,
  but the position book should be keyed to allow it later.
- Corporate actions (splits, bonuses, dividends) and their effect on open
  derivative positions — deferred; needs a dedicated event type.
