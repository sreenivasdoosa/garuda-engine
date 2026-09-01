# Garuda Engine — Detailed Design

**Status:** Draft v1.0 · 2026-08-28
**Scope:** Full technical design for the Python rewrite of the reference Java algo-trading engine.
**Companions:** [`SCOPE_DECISIONS.md`](SCOPE_DECISIONS.md) (what is in and out) ·
[`JAVA_FEATURE_INVENTORY.md`](JAVA_FEATURE_INVENTORY.md) (what the Java engine does) ·
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) (how it gets built)

---

## 1. Product shape

Garuda is a **single-process, self-hosted algorithmic trading engine**. One operator installs it on
their own machine or their own cloud box, logs in as `admin`, and manages a set of **trading
clients** — named broker accounts belonging to them or their family.

```
                        one process, one machine
┌───────────────────────────────────────────────────────────────────┐
│  garuda-engine                                                    │
│                                                                   │
│   Market data ──► Strategy engine ──► RMS ──► Order manager ──►   │──► Brokers
│   (in-process)         │                          │               │
│                        └──────► Journal ◄─────────┘               │
│                                    │                              │
│   REST + WebSocket API ◄───────────┴── PostgreSQL                 │
└───────────────────────────────────────────────────────────────────┘
              ▲
              │
        Console + Terminal (React, served by the same process)
```

There is no tenancy, no billing, no licence gate, no email, no external service dependency. The
reference deployment's separate market-data service is absorbed as an in-process module.

### 1.1 Vocabulary

| Garuda term | Java equivalent | Meaning |
|---|---|---|
| **Trading client** | `USER_BROKERS_MAP` row (`USER_NAME` + `BROKER_NAME`) | One broker account. Unique display name; `(broker, client_id)` unique. |
| **Strategy definition** | `STRATEGY_DEFINITIONS` | A configured strategy: template + underlying + trigger + config. |
| **Subscription** | `USER_STRATEGY_SUBSCRIPTIONS` | A strategy assigned to a trading client, live or paper, with capital. |
| **Intent** | `TradeSignal` | What an evaluator emits. Not yet an order. |
| **Trade** | `Trade` / `TRADES` row | One logical position with its own SL, target and lifecycle. |
| **Combo** | `COMBO_ID` group | A multi-leg position whose legs are coordinated. |

The Java `USERS` table becomes trading clients; there is exactly one login identity, `admin`.

---

## 2. Technology

| Concern | Choice | Why |
|---|---|---|
| Language | Python 3.12+ | `Decimal`, `zoneinfo`, task groups, `slots` dataclasses |
| Concurrency | asyncio, single loop | One owner of engine state; no locks |
| Web | FastAPI + uvicorn | Native async, native WebSockets, OpenAPI for free |
| DTOs / validation | Pydantic v2 | Request/response shapes, config file validation |
| Database | PostgreSQL 16+ | `NUMERIC`, `timestamptz`, partitioning, JSONB for the journal |
| ORM / SQL | SQLAlchemy 2.0 async + asyncpg | Typed core for hot paths, ORM for CRUD |
| Migrations | Alembic | Direct analogue of Flyway |
| Logging | structlog → JSON + rotating files | Machine-readable, per-strategy and per-client log routing |
| Testing | pytest · pytest-asyncio · Hypothesis | Behavioural + property-based |
| Lint / types | ruff · mypy (strict) · custom float-in-money rule | §12.3 |
| Frontend | Existing React 18 + TS + Vite 5, stripped | §11 |
| Packaging | `pyproject.toml`, `uv` for dev, wheel for install | Reproducible on Windows and Linux |

**Excluded on purpose:** Celery/Redis (no distributed workers), pandas in hot paths (Decimal-hostile;
allowed in reporting only), APScheduler (its own clock defeats deterministic replay — §7.4).

---

## 3. Repository layout

Monorepo, mirroring the Java structure.

```
garuda-engine/
├── backend/
│   ├── pyproject.toml
│   ├── alembic/
│   │   └── versions/
│   ├── src/garuda/
│   │   ├── domain/          Money · Instrument · Exchange · Calendar · Order · Fill · Position · Trade
│   │   ├── protocols/       BrokerAdapter · MarketDataFeed · Store · Clock · EventBus  (the contract)
│   │   ├── core/            engine loop · router · clock · event bus · unit of work
│   │   ├── journal/         append-only event log, fold, replay, reconciliation
│   │   ├── marketdata/      feeds · instruments · history · synthetics · rules
│   │   ├── brokers/         zerodha · fyers · kotak · dhan · paper
│   │   ├── engine/          evaluators · indicators · schedulers · state
│   │   ├── ordermgmt/       order manager · state machine · escalation · protections
│   │   ├── trademgmt/       trade book · exits · trailing SL · square-off · watchdogs
│   │   ├── rms/             validators · breach types · kill switches · trackers
│   │   ├── capital/         allocation models · sizers · compounding
│   │   ├── reports/         EOD · MTM · charges · analytics
│   │   ├── persistence/     repositories · models · seed data
│   │   ├── api/             REST routers · WebSocket · auth · DTOs
│   │   ├── alerts/          alert manager, levels, coalescing
│   │   ├── config/          file config, DB config, hot reload
│   │   └── testing/         contract suite · harnesses · fixtures · fake clock
│   └── tests/
│       ├── unit/  integration/  contract/  replay/
├── frontend/                Console + Terminal (stripped from the Java UI)
├── scripts/
│   ├── linux/               install.sh · upgrade.sh · start.sh · stop.sh · status.sh
│   ├── windows/             install.ps1 · upgrade.ps1 · service wrapper
│   └── docker/              Dockerfile · compose.yaml
└── docs/
```

---

## 4. Layers and dependency rules

```
┌────────────────────────────────────────────────────────────────┐
│  api/          REST · WebSocket · auth                          │
├────────────────────────────────────────────────────────────────┤
│  engine/       orchestration — composes the services below into │
│                the one path an intent can take                  │
├────────────────────────────────────────────────────────────────┤
│  trademgmt/ ordermgmt/ rms/ capital/ reports/                   │
│  application services — venue-neutral, siblings, no broker      │
│  imports and no imports of each other                           │
├────────────────────────────────────────────────────────────────┤
│  core/ journal/          engine loop · clock · bus · unit of work│
├────────────────────────────────────────────────────────────────┤
│  protocols/              the contracts, in terms of domain types │
├────────────────────────────────────────────────────────────────┤
│  domain/                 pure data + invariants, no I/O          │
├────────────────────────────────────────────────────────────────┤
│  brokers/ marketdata/ persistence/   all venue- and vendor-      │
│                                      specific code lives here    │
└────────────────────────────────────────────────────────────────┘
```

**Rules, enforced by an import-linter check in CI:**

1. `domain/` imports nothing from Garuda except `domain/` — it is the most
   primitive layer, below the protocols, because a contract is expressed *in
   terms of* domain values (`BrokerAdapter.place(req: OrderRequest)`).
2. `core/`, `engine/`, `rms/` etc. never import `brokers/` or `marketdata/` concretely — only
   `protocols/`.
3. `brokers/` and `marketdata/` never import `engine/` or `trademgmt/`.
4. Nothing outside `persistence/` writes SQL.
5. Nothing outside `core/clock.py` calls `datetime.now()` or `asyncio.sleep()`.

Rule 5 is what makes §12.4 replay possible, and it is checked by a lint rule, not by discipline.

---

## 5. Domain model

### 5.1 Money and prices

```python
@dataclass(frozen=True, slots=True)
class Money:
    amount: Decimal
    currency: Currency
```

- Arithmetic across currencies raises. No implicit conversion.
- One declared `base_currency` per portfolio; positions keep native currency; conversion happens
  once, at an explicit reporting boundary, with the rate source and timestamp recorded.
- Prices quantize to the instrument's tick size **at the adapter boundary**, rounding mode stated.
- **Postgres:** `NUMERIC(20,4)` for money, `NUMERIC(20,6)` for prices, `NUMERIC(16,8)` for factors.
  Never `double precision`.

> **Known divergence from Java.** The Java `TRADES` table stores every price, P&L and charge column
> as `DOUBLE`. Garuda's numbers will therefore differ from Java's in the last paise on some trades.
> This is intended and must not be "fixed" by matching the float behaviour.

### 5.2 Exchange, calendar, trading day

```python
@dataclass(frozen=True)
class Exchange:
    code: str                    # NSE, BSE, MCX, CME, NYSE
    timezone: ZoneInfo
    currency: Currency
    calendar: TradingCalendar    # sessions, holidays, half-days, special days
    settlement: SettlementModel
```

A **trading day is not a calendar date**. MCX evening sessions run past 23:00 IST; CME opens the
prior evening in Chicago. Daily P&L rollover, EOD reconciliation, "today's orders" and the
`TRADE_DATE` partition key all key off `calendar.trading_day_for(instant)`.

All timestamps are stored as `timestamptz` in UTC. Naive datetimes are rejected at construction.
Local time exists only for display and calendar arithmetic.

### 5.3 Instrument

```python
@dataclass(frozen=True)
class Instrument:
    id: InstrumentId              # canonical, engine-owned
    exchange: Exchange
    kind: InstrumentKind          # EQUITY FUTURE OPTION INDEX SYNTHETIC
    trading_symbol: str
    lot_size: int
    tick_size: Decimal
    multiplier: Decimal
    freeze_qty: int | None
    underlying: InstrumentId | None
    expiry: date | None
    strike: Decimal | None
    option_type: OptionType | None        # CALL PUT
    exercise_style: ExerciseStyle | None  # EUROPEAN AMERICAN
    settlement_type: SettlementType | None # CASH PHYSICAL
```

`InstrumentId` is canonical. Adapters translate to and from broker tokens at their own boundary; the
core never sees a broker symbol string. `exercise_style` and `settlement_type` are carried from day
one even though NSE options are European — retrofitting them later touches the position book.

### 5.4 Trading client

```python
@dataclass(frozen=True)
class TradingClient:
    id: TradingClientId
    display_name: str          # unique, what the UI shows
    broker: BrokerCode         # ZERODHA FYERS KOTAK DHAN
    client_id: str             # broker account id;  (broker, client_id) unique
    enabled: bool
```

Login state, funds, margins and broker sessions hang off the trading client. Paper-vs-live is
**not** a property of the client — see §9.4.

### 5.5 Trade and order

`Trade` is the logical position (Java's `Trade`): one symbol, one direction, its own SL, target,
trailing state and exit reason. Legs of a combo are separate `Trade` rows sharing a `combo_id`.

Order state machine, total and explicit:

```
PENDING_NEW → NEW → PARTIALLY_FILLED → FILLED
                 ↘ CANCELLED  ↘ REJECTED  ↘ EXPIRED
   in-flight: PENDING_CANCEL, PENDING_REPLACE
   terminal-unknown: UNKNOWN  → halts trading on that instrument
```

Every transition is journalled. An unmapped broker status becomes `UNKNOWN` and halts — never a
guess.

---

## 6. Persistence

### 6.1 Schema groups

Carried over from Java in shape (so the stripped frontend keeps working), with `USER_NAME` +
`BROKER_NAME` collapsed into `trading_client_id`, money columns switched to `NUMERIC`, and dropped
subsystems removed.

| Group | Tables (abridged) |
|---|---|
| Reference | `exchanges` · `holidays` · `special_trading_days` · `event_days` · `symbols` · `symbol_broker_info` · `instruments` |
| Clients | `trading_clients` · `trading_client_sessions` · `client_capital` · `capital_change_history` · `client_margins` · `client_notes` |
| Strategy | `strategy_templates` · `strategy_definitions` · `strategy_config` · `strategy_day_overrides` · `strategy_tranch_schedules` · `strategy_breakout_watches` · `hedge_schedules` · `strategy_indicator_rules` · `stock_universes` |
| Subscriptions | `subscriptions` (strategy ↔ client, mode, capital) · `subscription_state` |
| Policies | `sl_target_policy` · `trailing_sl_policy` · `strike_selection_policy` · `exit_policy` · `positional_exit_policy` · `order_fill_escalation_policy` |
| Allocation | `allocation_models` · `allocation_model_strategies` · `strategy_days_allocation` |
| Trading | `trades` (partitioned by `trade_date`) · `trade_signals` · `trade_log` · `orders` |
| Journal | `event_journal` (partitioned by `trading_day`) · `journal_snapshots` |
| RMS | `rms_config` · `rms_params` · `rms_breach_log` · `kill_switches` · `rms_daily_stats` |
| Charges | `brokerage_plans` · `brokerage_plan_rates` · `statutory_charges` · `statutory_charges_broker_overrides` |
| Reports | `eod_pnl_reports` · `eod_pnl_reports_positional` · `positional_daily_mtm` · `pnl_snapshots` |
| System | `system_config` · `app_config` · `audit_log` · `alerts` · `broker_api_stats` · `corporate_actions` |

Dropped entirely: everything billing, licence, email, permission, mock, external-P&L, signal-export,
`symbol_params` (dead in Java — zero source references), `risk_mgmt_methods`, `compounding_methods`.

### 6.2 Seed data

Shipped as versioned SQL/YAML seeds, generated from the Java database where it exists:

`exchanges` · `symbols` (symbol info) · `holidays` · `strategy_templates` · `brokerage_plans` +
rates · `statutory_charges` · `rms_config` defaults.

Everything else starts empty and is entered through the Console.

### 6.3 The journal

**Decision: journal alongside, not instead of, relational state.**

```sql
CREATE TABLE event_journal (
  seq            BIGSERIAL,
  trading_day    DATE        NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  event_type     TEXT        NOT NULL,
  aggregate_type TEXT        NOT NULL,   -- TRADE ORDER POSITION SUBSCRIPTION SYSTEM
  aggregate_id   TEXT        NOT NULL,
  correlation_id TEXT,                   -- ties intent → order → fill → exit
  actor          TEXT        NOT NULL,   -- ENGINE ADMIN BROKER SCHEDULER
  payload        JSONB       NOT NULL,
  PRIMARY KEY (trading_day, seq)
) PARTITION BY RANGE (trading_day);
```

Rules:

1. **Same transaction.** A `UnitOfWork` writes the journal append and the row mutation in one
   commit. They cannot diverge from a crash — this is the whole point, and it is why the journal is
   worth having even though the tables stay authoritative.
2. **Tables are authoritative for reads.** The Console and every report query normal tables. No
   projection rebuild on the read path.
3. **Startup: fold and compare.** Replay the day's journal into an in-memory position/trade state,
   diff against the tables, and on mismatch **halt, alert, do not trade** — the same fail-closed
   rule as broker reconciliation (§8.5).
4. **Replay is a test mechanism.** A recorded journal + `ReplayClock` reproduces engine state
   byte-identically (§12.4). It is not a strategy research tool.

What this buys over Java: crash recovery that is provable rather than hopeful, a real audit trail,
and a regression harness. What it does not do: make positions a fold at runtime.

---

## 7. Core runtime

### 7.1 Event loop and ownership

One asyncio loop owns all engine state. No locks, no shared mutable state across threads. Broker
SDKs that are blocking run in a bounded `ThreadPoolExecutor` and marshal results back onto the loop.

CPU-heavy work (indicator recomputation over long windows, report generation) goes to a
`ProcessPoolExecutor`. Blocking the loop delays every order in the system.

### 7.2 Event bus and backpressure

In-process async pub/sub. Bounded queues with a **documented policy per stream**:

| Stream | Policy |
|---|---|
| Ticks | drop-oldest, count the drops, alert past a threshold |
| Order/fill events | never drop; block the producer; alert if the queue stays deep |
| Journal appends | never drop |
| UI broadcasts | drop-oldest per client; a slow browser never stalls the engine |

The last row is a direct lesson from the Java engine, where one half-dead WebSocket client froze
the summary broadcaster.

### 7.3 Threading budget

Java sized thread pools for 1000 users. Garuda targets ~20 trading clients, so: one loop, one small
IO thread pool for blocking SDKs, one process pool for reports. No sizing profiles, no scaling
package.

### 7.4 Clock

```python
class Clock(Protocol):
    def now(self) -> datetime: ...
    async def sleep_until(self, when: datetime) -> None: ...
    def timer(self, at: time, tz: ZoneInfo, cb) -> Handle: ...
```

`LiveClock` and `ReplayClock`. Scheduling (tranches, hedge windows, square-off, EOD) goes through
the clock, which is why there is no APScheduler. A lint rule bans `datetime.now()` and
`asyncio.sleep()` outside `core/clock.py`.

---

## 7.5 The day, and the process that never stops

The engine runs continuously. It is not started before the open and stopped
after the close: it comes up, and from then on each venue's day begins and
ends underneath it.

### Phases are venue-relative, never wall-clock

The reference engine runs one worker loop that initialises "when the hour is at
least 6" and closes the day "at 23:45". Those are Indian hours written into
code, and they do not survive a second timezone: at 06:00 IST a US venue is
mid-session, and at 23:45 IST an MCX evening session has only just closed.

So Garuda derives **every** phase from the venue's own calendar and its own
offsets, in the venue's own timezone, on the venue's own trading day:

| Phase | When |
|---|---|
| `DAY_INIT` | first session open − `day_init_lead` |
| `ALGO_START` | first session open − `algo_start_lead` |
| `PRE_OPEN` | the venue's pre-market start |
| `SESSION_OPEN` | each session's open |
| `INTRADAY_SQUARE_OFF` | last session close − `intraday_square_off_lead` |
| `SESSION_CLOSE` | each session's close |
| `REPORTS` | last session close + `report_lag` |
| `EOD` | last session close + `post_market_window` |

There is deliberately no positional square-off phase either. The venue
force-closes intraday positions, so that offset is the venue's business. When a
carry-forward position exits is the strategy's — its exit mode, exit days and
exit time — and no venue has an opinion about it. Putting it on the venue would
mean two places decide the same thing, and the wrong one would win on the day
they disagreed.

There is deliberately no login phase. The reference engine schedules one
because it logs in automatically; here the operator clicks Login whenever they
choose, so a phase named for it would imply a gate that does not exist — and
sooner or later someone would build the gate.

The offsets are columns on the exchange, so adding CME means adding a row, not
an `if`. NSE's day begins at 06:15 IST and MCX's ends after 23:30 IST because
their rows say so, not because the code knows about India.

### Venues run independently

Two venues are routinely in different phases at the same moment: MCX is still
trading while NSE is in EOD, and a US venue's day opens while both are closed.
There is therefore no global "the market is open" and no global day boundary —
each venue advances through its own phases, and a task is registered against a
venue rather than against the process.

Work that belongs to no venue — retention pruning, backups, log rotation — is
scheduled separately, on a system schedule, and preferably while nothing is
trading.

### Tasks are idempotent and recorded

Each task records the trading day it last completed for its venue. Two
consequences:

* **A restart does not repeat the day.** The reference engine keeps its
  last-run date in memory, so restarting after EOD re-runs EOD. Squaring off
  twice is not harmless.
* **A missed phase is caught up rather than skipped.** A process that was down
  at 06:15 runs `DAY_INIT` when it comes up at 07:00, because the record says
  today's has not run — not because a timer happened to fire.

That makes the scheduler a *reconciler* rather than a timer: it repeatedly asks
"which phases are due for which venue and have not run", which is the same
question after a crash as before one.

### The clock is still the clock

Every instant comes from the `Clock` protocol, so a whole trading day —
day-init, session, square-off, EOD — replays in seconds against a
`ReplayClock`. Testing expiry-day behaviour does not require waiting for an
expiry.

## 8. Market data (in-process)

### 8.1 Feeds

`MarketDataFeed` protocol; implementations for **Zerodha, Fyers, Dhan**. Each owns its own
reconnect, rate limiting and subscription bookkeeping, and emits `Disconnected` when unsure.

A `FeedRouter` picks the active provider per exchange/segment, supports **hot switch** at runtime
(the Java `SwitchTicker` behaviour), and publishes a normalized `Tick` regardless of source.

### 8.2 Instruments and history

- Instrument master downloaded and refreshed per provider; normalized into `instruments`; broker
  token mapping held in `symbol_broker_info`.
- Historical candles (intraday and daily) fetched per provider behind one `HistorySource` protocol,
  cached in Postgres, validated before use (`CandleDataValidator` equivalent — the Java engine
  already learned that broker candles lie).
- Option chain fetch per provider.

### 8.3 Synthetic instruments

First-class, as in Java: **IV**, **PCR**, **straddle price**, **synthetic future**. Each has its own
price provider, tick stream and candle history, and is addressable by strategies exactly like a real
instrument. Black-Scholes/greeks live in `marketdata/pricing.py`.

### 8.4 Market-data rules

The Java `RulesProcessor` — declarative rules over ticks and candles that fire signal events — is
ported. Rules are configured from the Console (`Signal Rules`, `Strategy Rules Map`) and feed the
engine's `EXTERNAL_SIGNAL` event type in-process rather than over HTTP.

### 8.5 Staleness and fail-closed

Stale price, zero price, not-traded-today, freak price, wide spread and insufficient depth are all
RMS breach types (§10). Market data never guesses: an unavailable quote is an error, not a
last-known value.

---

## 9. Brokers

### 9.1 The adapter contract

```python
class BrokerAdapter(Protocol):
    async def connect(self, session: BrokerSession) -> None: ...
    async def place(self, req: OrderRequest) -> BrokerOrderId: ...
    async def modify(self, id: BrokerOrderId, changes: OrderChanges) -> None: ...
    async def cancel(self, id: BrokerOrderId) -> None: ...

    async def fetch_orders(self) -> Sequence[BrokerOrder]: ...
    async def fetch_positions(self) -> Sequence[BrokerPosition]: ...
    async def fetch_holdings(self) -> Sequence[BrokerHolding]: ...
    async def fetch_funds(self) -> Funds: ...
    async def fetch_instruments(self) -> Sequence[Instrument]: ...

    def events(self) -> AsyncIterator[BrokerEvent]: ...
```

`BrokerEvent` is a closed union: `OrderAccepted` · `OrderRejected` · `OrderModified` ·
`OrderCancelled` · `Fill` · `Assignment` · `MarginCall` · `AccountUpdate` · `Disconnected` ·
`Resynced`. `Assignment` is present from day one though European NSE options will never fire it.

**Talk to broker REST APIs directly. Do not use a vendor SDK.**

A vendor SDK owns its own URLs and its own HTTP client, which costs two things
that matter here. Its traffic cannot be routed through a proxy, so an account
whose trading APIs are IP-whitelisted cannot be served from a machine that is
not that address. And its errors arrive in the vendor's own shapes rather than
the taxonomy below, so every adapter normalises differently.

The reference engine hit exactly this: one broker's SDK hardcodes its endpoints
with no hook to reroute them, so that broker's traffic had to stay direct while
every other broker's could be routed — splitting one deployment across two
source addresses. Speaking HTTP directly removes the constraint.

**Adapter obligations** — all checked by the contract suite (§12.2):

- Idempotency via client-generated order ids; a retry never double-sends.
- Normalize broker errors into `Retryable · Rejected · AuthExpired · RateLimited · Fatal`.
- Own reconnect and rate limiting internally.
- Never invent state. Unknown is `UNKNOWN`.
- Translate system ↔ broker in **both** directions for orders, positions and holdings, at the
  adapter boundary only.

### 9.2 Login — operator-initiated only

No auto-login, no TOTP automation, no stored credentials for unattended use.

```
Admin clicks "Login" on a trading client
   → adapter returns an OAuth URL (Zerodha, Fyers, Dhan) or takes direct credentials (Kotak Neo)
   → operator completes it in the browser
   → callback lands on /api/v2/brokers/{client}/callback
   → access token encrypted at rest, held for the session's natural lifetime
```

On expiry: emit `AuthExpired`, raise an alert, and **halt trading for that client**. It never
self-heals, and no scheduled job attempts to renew it.

### 9.3 Supported adapters

Zerodha (Kite Connect) · Fyers (API v3) · Kotak Neo · Dhan. Plus the paper broker (§9.4). XTS,
The remaining brokers the reference supports are not ported; the contract suite is what makes adding one later
cheap.

### 9.4 Paper trading

**Mode is a property of the subscription, not of the system or the client.** The same strategy
definition can be live on client A and paper on client B, in the same process, driven by the same
signals and the same evaluator instance.

```
Intent ──► Sizer ──► RiskGate ──► Router ─┬─ subscription.mode == LIVE  ──► BrokerAdapter
                                          └─ subscription.mode == PAPER ──► PaperBroker
```

The paper broker models spread, slippage and rejection explicitly, with its assumptions logged. A
fill at mid is a lie and is not the default. Paper trades journal, report and appear in the Terminal
exactly like live ones, flagged `is_paper`.

Mock trading, mock sessions and mock trading days are **not** this feature and are not ported.

### 9.5 Reconciliation

On startup, and on every `Resynced`:

1. Fetch broker truth — orders, positions, holdings, funds.
2. Diff against engine state.
3. On mismatch: **halt, alert, do not trade.** Never auto-correct.

The broker is the source of truth for positions and cash; engine state is a cache that must be
provably consistent with it. The Console's position-mismatch panel (Java's `PositionMismatch`) is
the operator's view of step 2.

---

## 10. Strategy engine

### 10.1 Event pipeline

```
Tick / Scheduled / ExternalSignal / HedgeReplace / Periodic / Breakout / TranchComplete / EndOfDay / ConfigReload
      │
      ▼
StrategyEventDispatcher ── subscription registry, per-strategy fan-out
      │
      ▼
Evaluator.evaluate(ctx) ── stateless, pure; returns EvaluationResult
      │
      ▼
Intent(s) ──► Sizer ──► RiskGate ──► OrderManager ──► Router ──► Adapter | PaperBroker
                                                                    │
                                                                    ▼
                                                              BrokerEvent
                                                                    │
                                                                    ▼
                                                    TradeBook ──► journal ──► WebSocket ──► UI
```

Evaluators are **stateless**: all state arrives in `EvaluationContext` and all durable state changes
leave as intents or explicit state deltas. This is what makes them testable without a broker and
replayable.

### 10.2 Strategies are composed, not subclassed

The reference engine models a strategy template as a **class**: its
`strategy_templates` table has an `evaluator_class` column, and each template
is a subclass of a base evaluator. Garuda does not copy that, because the
evidence that it does not hold up is in the reference engine's own history.

Five things vary independently between strategies:

| Axis | Values |
|---|---|
| **What is traded, and which way** | sell options · buy options · futures · equity · any combination |
| **Entry trigger** | scheduled · tick · tranche · breakout · external signal · periodic |
| **Direction** | fixed · candle · indicator · IV skew · PCR · N-bars breakout |
| **Leg composition** | how many legs, their roles, how each instrument is chosen |
| **Exit** | SL · target · trailing · time · indicator · decay · combined |

Single inheritance can express exactly one axis. The reference engine spent it
on "template", and then had to thread the others through by hand: adding an
option-*buying* mode to an engine written for option-*selling* meant six new
helper methods and seventeen hardcoded `Direction.SHORT` replacements inside a
single evaluator. Multi-leg combos ended up as a *sibling* of advanced options
rather than a configuration of it, and the Console form accumulated ~29
hardcoded template-name checks.

**Garuda puts the variation in data.**

```
StrategyEvaluator (Protocol)
    evaluate(ctx: EvaluationContext) -> EvaluationResult

BaseEvaluator (ABC)        shared machinery: resolved config, leg emission,
│                          correlation ids, journal notes, exit bookkeeping
└── LegBasedEvaluator      the single concrete evaluator in core
```

Everything a template used to encode becomes a validated `StrategySpec`:

```python
@dataclass(frozen=True)
class LegSpec:
    role: LegRole                  # MAIN · HEDGE · PROTECTIVE
    selector: InstrumentSelector   # option strike · underlying future · equity · fixed
    side: SideRule                 # SAME_AS_SIGNAL · OPPOSITE · ALWAYS_LONG · ALWAYS_SHORT
    ratio: Fraction                # size relative to the main leg
    product: ProductType
    sequence: int                  # entry order; exits reverse it by default


@dataclass(frozen=True)
class StrategySpec:
    trigger: TriggerSpec
    direction: DirectionSpec
    legs: tuple[LegSpec, ...]
    sizing: SizingSpec
    exits: ExitSpec
```

The combinations then cost nothing to add:

| Strategy | Spec |
|---|---|
| Directional option | one option leg, side from the direction provider |
| Short straddle | two option legs, CE and PE, both `ALWAYS_SHORT` |
| Hedged short straddle | the above plus two `HEDGE` legs at an offset |
| Iron condor | four option legs |
| Covered call | one **equity** leg + one short **option** leg |
| Cash-future arbitrage | one **equity** leg + one **future** leg |
| Futures + options | one future leg + one option leg |

The reference engine's `TradeMode` enum disappears as a concept. Selling
options is `side=ALWAYS_SHORT` on an option leg; buying them is `ALWAYS_LONG`;
futures and equity are different selectors. What needed a new enum value and
seventeen edits becomes a row of data.

**Templates become named presets** — a `StrategySpec` skeleton plus capability
flags, stored as data with no `evaluator_class`. The Console form renders from
capabilities, so a new preset needs no UI change.

**Core ships no custom-logic evaluators.** Third parties can register one
through the `garuda.evaluators` entry point when no spec can express their
logic, but nothing in core is a bespoke subclass.

**One evaluator, and no abstract base above it.** A single-leg strategy is a
combo with one leg, so "combo" is not a special case to inherit from -- it is
the general case, and `N = 1` is not special. An ABC with exactly one concrete
subclass is ceremony rather than structure.

The evaluator stays an orchestrator: resolve direction, resolve each leg's
instrument, size, order the legs, emit intents. Every piece of real logic lives
in a selector, a direction provider, a sizer or an exit policy, each testable
on its own. An `if leg.kind is OPTION` branch appearing in the evaluator is the
signal that something belongs in a selector instead.

**Asset class lives on the leg, not the strategy.** Three selectors, in a
registry:

| Selector | Chooses by |
|---|---|
| `OptionSelector` | strike and expiry rules -- offset, delta, premium, OI rank, straddle |
| `FutureSelector` | expiry rules and rollover |
| `EquitySelector` | symbol |

**MTF is not a fourth.** It is a *product* on an equity leg -- funded delivery,
alongside CNC and MIS -- so it is `ProductType.MTF` on a `LegSpec`, not a
sibling of equity. Putting a funding mode on the same axis as an asset class is
one of the naming confusions this rewrite exists to remove.

**Indicators are never a template.** `INDICATOR` is a value that `trigger`,
`direction` and `exits` can each take, independently of one another and of what
the legs are. A scheduled entry with an indicator exit, an indicator-triggered
equity strategy, an indicator-directed option straddle -- all field
combinations, no inheritance. This is what removes the "indicator" and
"advanced" axes from the template list entirely.

#### Leg count

Capped at **8 by default, configurable up to a hard ceiling of 16**, held in
`system_config` and validated when a strategy is saved.

Eight covers every structure this engine is built for: an iron condor is four
legs, and a *hedged* iron condor is exactly eight -- which is the reason the
cap is a setting rather than a constant. A futures overlay on top of that is
nine. Elsewhere in the world the ceiling is far higher: CME accepts
user-defined spreads of up to forty legs.

The cap counts **legs in the spec, not resulting orders**. Freeze-quantity
slicing turns one leg into several broker orders, so a four-leg strategy at
size may legitimately place twenty. Capping orders would break sizing.

#### Exits: per-leg and combined, both live at once

Both apply simultaneously, and neither is restricted to a particular structure:

- **Combined** -- one `ExitSpec` on the strategy, evaluated against the
  position as a whole. Non-directional option selling uses this for a stop on
  total premium.
- **Per-leg** -- an optional `ExitSpec` on any `LegSpec`, evaluated against
  that leg alone.

Whichever triggers first wins; there is no precedence rule between them,
because in practice both are real stops and the earlier one is the one that
matters.

What happens to the *other* legs when one exits is a declared **linkage**, not
a hardcoded rule:

| Linkage | Meaning |
|---|---|
| `EXIT_SELF` | only this leg exits |
| `EXIT_GROUP` | every leg in the combo exits |
| `EXIT_LINKED` | legs correlated to this one exit -- a main leg pulls its hedge |

Defaults follow leg role: a `MAIN` leg exiting pulls its `HEDGE`; a `HEDGE`
exiting leaves the main unprotected, which is a decision the operator must
make rather than one the engine should assume. Every combination is
configurable; the engine does not privilege any particular structure.

*The cost, stated honestly:* a data-driven spec is harder to read in a debugger
than a class, and a nonsensical spec must be rejected when it is saved rather
than at 09:20 on expiry day. So `StrategySpec` validation is strict and total —
a hedge leg with no main leg, a ratio that cannot be expressed in lots, an
equity leg on a venue that does not trade equity — and the preset library
constrains what the Console can produce in the first place.

### 10.3 Configuration resolution

Java's three-level config tree collapses to two layers plus a dated capital override:

```
strategy_config              base values for a strategy definition
      ▲ overridden by
strategy_day_overrides       by day type: MON…FRI, EXPIRY, DTE_0, DTE_1, DTE_2…
      ▲ and, for capital only
event_days                   dated: 2026-02-01 "Budget" → capital 50%
```

- **Day overrides** can override *any* property — SL, trailing SL, combined SL, entry time, lots,
  strike offset.
- **Event days** are dated and touch **capital allocation only**: on that date a strategy that
  normally trades 10 lots trades 5 or 3. Pre-configured; applied automatically.
- Resolution is a pure function `resolve(strategy, trading_day) -> ResolvedConfig`, unit-testable
  without a database, and its result is journalled with the intent so any decision can be explained
  after the fact.

### 10.4 Direction and instrument selection

- **Direction providers:** fixed · candle · indicator · IV-skew · PCR · N-bars breakout.
- **Instrument resolvers:** option strike · hedge offset · underlying equity · underlying future.
- **Strike selection policy** and the straddle selector are configuration, not code.

Both are registries so a new provider or resolver is a registration, not a change to the evaluators.

### 10.5 Tranches, hedging, breakout

- **Tranches** — scheduled multi-entry through the day, each with its own schedule, gap and position
  cap; `TranchComplete` events chain them.
- **Hedging** — hedge schedules, hedge windows, hedge replacement and its recovery job.
  **Hedge enable/disable is a strategy-level setting**, moved up from tranch level as in Java.
- **Breakout watch** — levels, trigger modes, and shared evaluation across subscriptions watching
  the same level.

### 10.6 Indicators

ATR · Bollinger · BB-squeeze · CCI · Choppiness · Heikin-Ashi · MACD · moving averages · pivot
points · Renko · RSI · standard deviation · Supertrend · Vortex · VWAP · candlestick patterns.

Computed once per (instrument, interval) per tick batch and shared across every subscription that
needs them — the Java "evaluation sharing" optimization, which stays because it is about
correctness and CPU per tick, not about user count.

The rule engine evaluates AND/OR trees of comparators over indicator outputs, configured from the
Console.

---

## 11. Order, trade and risk

### 11.1 Sizing and allocation

Allocation models map capital to strategies; `SequentialLotAllocator` and
`RiskAwareSequentialLotAllocator` convert capital into lots; `EquitySizingCalculator` handles
share-count sizing with leverage. Compounding is a per-client capital policy with a change history.

Sizing is **engine-owned** — strategies emit intent, not quantity.

### 11.2 RiskGate

Every intent passes the gate; there is no path around it. Checks, from Java's 28 breach types:

| Family | Checks |
|---|---|
| Price quality | quote unavailable · price zero · stale · not traded today · freak price · deviation |
| Liquidity | low volume · wide spread · insufficient depth |
| Order shape | qty exceeded · value exceeded · freeze qty exceeded |
| Rate | order rate · order-operation rate · exit rate |
| Position | per symbol · per strategy · total · combo total |
| Account | daily loss exceeded · margin |
| System | market closed · broker stopped · kill switch active · volatility circuit · error-rate circuit |
| Exit safety | duplicate exit order · exit qty exceeds position |

Config is hierarchical (system → trading client → strategy). Breaches are journalled, logged to
`rms_breach_log`, surfaced in the Console, and rolled into daily stats. Kill switches are typed and
scoped, and the global one is the last line of defence against a strategy looping orders.

### 11.3 Order management

- Order types LIMIT · MARKET · SL_MARKET · SL_LIMIT; products MIS · CO · BO · NRML · CNC · MTF.
- **Order-fill escalation**: a configurable ladder (limit → reprice → chase → market) with per-step
  timeouts, so an unfilled entry does not sit forever.
- **Freeze-qty slicing**: one logical entry becomes N broker orders when it exceeds the exchange
  freeze limit; the slices are independent trades sharing a group name.
- **Order protections**: per-segment price-band buffers.
- Idempotent placement via client order ids; retries never double-send.

### 11.4 Trade management

- Lifecycle `OPEN → ACTIVE → COMPLETED | CANCELLED`.
- The full Java exit-reason vocabulary (~50 values) is preserved verbatim — it is the operator's
  language and appears in every report.
- **Trailing SL**: ATR · EMA · Heikin-Ashi · Supertrend · risk-multiple · custom.
- **Exit policies**: SL/target policy, positional exit policy, max holding, time-based exit,
  signal flip, decay thresholds, portfolio and group SL/target.
- **Square-off**: scheduled EOD job, manual from the Console, dispatcher with a max-attempt cap,
  combo-aware so legs of one combo unwind together.
- **Watchdogs**: stale-signal and tick-fallback, both ported.
- **Trade log**: every event in a trade's life, rendered as the Console's trade timeline.

### 11.5 Corporate actions

Splits, bonuses and dividends adjust open derivative and equity positions via a `ca_factor` on the
trade, applied by a dated sweep — as in Java.

---

## 12. Testing

### 12.1 Behavioural only

**No test reads production source and asserts on its text.** Java's own overview records that 447
such tests caught zero defects across two refactors. Every assertion here is on what the engine
*produced*: emitted intents, order requests, journal events, resulting positions, P&L.

Layers:

| Layer | Method |
|---|---|
| Money and price arithmetic | Hypothesis property tests — no precision loss, no currency mixing, tick quantization is idempotent |
| Order state machine | Exhaustive transition table, legal and illegal |
| Config resolution | Pure-function tests over day types and event days |
| Evaluators | Harness drives the real entry path against a real option chain; assert leg count, ordering, roles, strikes, remarks |
| RMS | Each breach type has a scenario that triggers it and one that must not |
| Adapters | Contract suite (§12.2) + recorded broker responses replayed |
| Engine | Deterministic journal replay (§12.4) |
| Recovery | Kill the process mid-fill; assert reconciled state or a clean halt |
| API | Response-shape tests against the frontend's expectations |

### 12.2 Adapter contract suite

`garuda.testing.contract` is a pytest suite any adapter must pass, using a recorded-response
transport. It is the artefact that makes a new broker cheap and reviewable **without broker
access**, and it is written in Phase 1, before the second adapter exists.

### 12.3 Decimal enforcement

A ruff plugin (or a targeted AST check in CI) fails the build on `float` literals, `float()` calls
and float-typed columns anywhere under money or price paths. Hypothesis tests assert that a
round-trip through the database preserves the exact `Decimal`.

### 12.4 Deterministic replay

Record a real day's journal once. In CI, feed it through `ReplayClock` and assert the resulting
state is byte-identical. This is the regression net for the whole rewrite: it catches the class of
bug where a refactor quietly changes an exit decision.

It is **test infrastructure, not a backtester** — see §14.

---

## 13. API, frontend and operations

### 13.1 API

FastAPI, mounted at `/api/v2/...` with response shapes close to Java's so the copied frontend
needs minimal rework. WebSocket at `/socket` carries ticks, trade updates, position updates, alerts
and terminal summaries, with per-client bounded queues and non-blocking sends.

Auth: single `admin` identity, password hashed with Argon2 in `system_config`, set by the installer
to a default the operator changes from the UI on first login. Short-lived JWT + refresh. No roles,
no permission matrix, no resource gating.

### 13.2 Frontend

Copy the Java React app, then strip:

**Remove** — user portal (`/dashboard`, `/terminal`, `/brokers`, `/subscriptions`, `/analytics`,
`/reports`, `/billing`, `/alerts`, `/profile`), all billing pages, mock-trading pages, licence info,
symbol-broker-config, email templates, permissions gating, external-P&L fields, the four brand
builds, and every string carrying the reference engine's branding.

**Keep** — the Console's fourteen sections, `/terminal-admin`, `/live-feed`, the design system, the
charting stack. Rename `Users` → `Trading Clients` throughout. One default brand, `garuda-engine`;
white-labelling stays possible as theming, not as a build matrix.

### 13.3 Configuration and secrets

- `config/application.toml` — static: DB connection, ports, paths, feature flags. Pydantic-validated
  at startup; the process refuses to start on an invalid config.
- `config/.env` (0600) — secrets: DB password, JWT secret, broker API keys.
- `system_config` table — runtime-changeable settings, editable from the Console, hot-reloaded via
  a `ConfigReload` event.

### 13.4 Observability

- **Alerts** with levels, entity types and coalescing, surfaced in the Console. No email, no
  Telegram — the in-app panel is the only channel.
- **Structured logs**, JSON, rotating, routed per strategy and per trading client as Java does.
- **Audit log** for every operator mutation.
- **System status** — feed health, broker session state, queue depths, loop lag, journal lag.

### 13.5 Deployment

| Target | Shape |
|---|---|
| **Linux** | `scripts/linux/install.sh` — venv under `/opt/garuda`, systemd unit, Postgres role and DB, Alembic upgrade, seed load. `upgrade.sh` re-runs migrations and restarts. |
| **Windows** | `scripts/windows/install.ps1` — venv under `%ProgramData%\Garuda`, Windows Service via `pywin32`, same migration and seed steps. `upgrade.ps1` mirrors it. |
| **Docker** | `scripts/docker/compose.yaml` — engine + Postgres + a volume. Offered as an additional path, not the only one. |

Backups: a scheduled `pg_dump` to a local path chosen by the operator, with retention. No S3.

---

## 14. Backtesting

Supported, **opt-in, and data-source-driven**.

- Core ships **no historical data and no data loader**. Backtesting is disabled by default.
- `HistorySource` is a protocol. An operator who has a history database they trust configures it and
  enables backtesting; the engine then feeds that data through the **same** evaluator, sizer and
  RiskGate path that runs live, routed to the paper broker.
- Output is behavioural first — intents, fills, rejections, position states — with performance
  figures reported alongside the data-quality caveats.

The reasoning in `ARCHITECTURE.md` §1.1 stands and explains *why* it is opt-in: Indian options
history is incomplete, broker candle APIs reconstruct intraday bars from snapshots so highs and lows
are frequently wrong, and vendor archives are inconsistent. A backtester on bad data does not fail
loudly — it produces confident, specific, wrong numbers. Garuda will not supply that data, and will
say so where the operator can see it.

`README.md` and `ARCHITECTURE.md` §1.1 are rewritten to this position as part of Phase 1.

---

## 15. Open items

1. Windows service wrapper — `pywin32` vs a bundled supervisor. Decide during Phase 1 packaging.
2. Whether `orders` becomes a first-class table or stays embedded in `trades` as Java has it.
3. Kotak Neo's login shape (no OAuth redirect) needs confirming against the live API during Phase 4.
4. Retention defaults for ticks and candles once real volume is observed.
