# Garuda Engine — Implementation Plan

**Status:** Draft v1.0 · 2026-08-28
**Companion to:** [`DESIGN.md`](DESIGN.md) · [`SCOPE_DECISIONS.md`](SCOPE_DECISIONS.md)

## How this plan works

Small blocks first, connected one at a time. Every phase ends with a **system that runs** and a
**behavioural test suite that proves it** — never a half-wired subsystem waiting on the next phase.

Phase 1 is the vertical slice: thin, but it touches every seam. Everything after it adds breadth to
seams that already exist and are already tested.

Rules that hold for every phase:

- No source-text-pin tests. Assert on what the engine produced.
- No `float` in a money or price path.
- No `datetime.now()` outside the clock.
- A phase is not done until its Console pages work against the real backend.

Sizing is relative effort, not a commitment. `M` ≈ a solid week of focused work.

---

## Phase 0 — Foundations · size S

Guardrails before any trading logic, because retrofitting them is what makes rewrites fail.

**Deliverables**

- Monorepo skeleton per `DESIGN.md` §3; `pyproject.toml`; dev setup with `uv`.
- Tooling: ruff, mypy strict, import-linter enforcing the layer rules, the Decimal lint rule,
  pytest + Hypothesis, GitHub Actions CI.
- Postgres dev environment (compose file), Alembic initialised.
- **Domain model**: `Money`, `Currency`, `Exchange`, `TradingCalendar`, `Instrument`,
  `InstrumentId`, and the enum vocabulary (segments, products, order types, exit reasons).
- Property tests: no precision loss, no currency mixing, tick quantization idempotent,
  `trading_day_for()` correct across MCX evening sessions and a DST-shifting foreign venue.
- Rewrite `README.md` and `ARCHITECTURE.md` §1.1 to the opt-in-backtesting position; strip the
  remaining template language; add `LICENSE` (AGPL-3.0), `CONTRIBUTING.md`, `CLA.md`.
- `git init`, first commit.

**Exit criteria** — `pytest` green, `mypy --strict` clean, import-linter passes, the Decimal rule
actually fails a deliberately planted `float`.

---

## Phase 1 — End-to-end vertical slice · size L

The agreed slice: **admin logs in → adds a Zerodha trading client in paper mode → OAuth login →
instruments load → live ticks arrive → a simple strategy evaluates on tick → intent → RMS → paper
fill → position and P&L in the Terminal → the day's journal replays byte-identically.**

**Deliverables**

- `protocols/`: `BrokerAdapter`, `MarketDataFeed`, `HistorySource`, `Store`, `Clock`, `EventBus`.
- `core/`: event loop, bounded-queue bus with per-stream policy, `LiveClock` + `ReplayClock`,
  `UnitOfWork`.
- `journal/`: `event_journal` table, same-transaction append, fold, startup compare-and-halt.
- Persistence for the slice: `exchanges`, `symbols`, `instruments`, `trading_clients`,
  `strategy_templates`, `strategy_definitions`, `subscriptions`, `trades`, `trade_log`,
  `event_journal`, `system_config`, `audit_log`, `alerts`. Alembic migrations + seed loader.
- **Zerodha market data**: instrument master download, tick feed, normalized `Tick`.
- **Zerodha broker adapter**: OAuth login flow only (no order routing yet) + `fetch_positions`,
  `fetch_funds`.
- **Paper broker**: explicit spread, slippage and rejection modelling.
- **One evaluator** — a deliberately simple scheduled or tick-triggered options entry, enough to
  exercise the pipeline honestly.
- **Sizer** + a minimal **RiskGate** (market closed, price stale, order qty/value, kill switch).
- **OrderManager** with the full state machine, client order ids, journalling.
- **TradeBook**: position, realized/unrealized P&L, exit on SL/target/square-off.
- **API**: auth (`admin` + Argon2), trading clients, broker login/callback, strategy definitions,
  subscriptions, trades, terminal summary, WebSocket for ticks/trades/positions/alerts.
- **Frontend copy-and-strip**, first pass: remove user portal, billing, mock, licence, permissions,
  email, brands, every branding string from the reference engine. Get login, Trading Clients,
  Subscriptions, Terminal and Live Feed working against the Python API.
- **Linux installer** skeleton (`install.sh`, systemd unit, migrations, seed).
- **Replay test**: record a session, replay it, assert byte-identical state.

**Exit criteria** — a real Zerodha paper session runs start to finish from the UI, and its journal
replays green in CI.

---

## Phase 2 — Market data, complete · size M

**Deliverables**

- Fyers and Dhan feeds; `FeedRouter` with per-exchange provider selection and runtime hot switch.
- Historical candles (intraday + daily) behind `HistorySource`, per provider, cached in Postgres,
  with the candle validator — broker candles are not trusted on arrival.
- Option chain fetch; expiries; freeze-limit sync; symbol auto-detect.
- **Synthetic instruments**: IV, PCR, straddle price, synthetic future — each with tick stream,
  candle history and price provider. Black-Scholes / greeks.
- Market-data **rules engine** feeding `EXTERNAL_SIGNAL` events in-process.
- Console: Data Providers, Signal Rules, Strategy Rules Map, Symbols, Exchanges, Holidays,
  Special Trading Days.

**Exit criteria** — a strategy can subscribe to a synthetic straddle and receive ticks; killing the
active provider fails over without dropping an order event.

---

## Phase 3 — Strategy engine, breadth · size L

**Deliverables**

- Template class hierarchy (`DESIGN.md` §10.2) with capability flags; Console form renders from
  capabilities, not from template-name checks.
- Config resolution: `strategy_config` + `strategy_day_overrides` (weekday / expiry / DTE-n) +
  dated `event_days` capital scaling. Pure, unit-tested, journalled with each intent.
- Direction providers: fixed, candle, indicator, IV-skew, PCR, N-bars breakout.
- Instrument resolvers: option strike, hedge offset, underlying equity, underlying future.
  Strike-selection policy and straddle selector as configuration.
- Indicator library (16 indicators) + AND/OR rule engine, with per-(instrument, interval) sharing.
- Tranches: schedules, gaps, position caps, `TranchComplete` chaining.
- Breakout watch: levels, trigger modes, shared evaluation.
- Hedging: hedge schedules, hedge windows, hedge replace + recovery job — **enable/disable at
  strategy level**.
- Cross-day strategy state and snapshots.
- Console: Strategy Engine, Strategy Configs, Strategy Policies, Allocation Models.

**Exit criteria** — every ported template runs end to end in paper mode against live data, with a
behavioural test per template asserting emitted legs, strikes, ordering and roles.

---

## Phase 4 — Live execution and full RMS · size L

The first phase where real money can move. Reviewed strictly.

**Deliverables**

- Zerodha live order routing: place, modify, cancel; broker order/position WebSocket; idempotency;
  error taxonomy; rate limiting; API stats.
- Order-fill escalation ladder; freeze-qty slicing; per-segment order protections.
- Reconciliation on startup and on every resync — halt on mismatch, never auto-correct.
- Watchdogs: stale signal, tick fallback.
- Square-off: scheduled, manual, dispatcher with attempt cap.
- Trailing SL suite: ATR, EMA, Heikin-Ashi, Supertrend, risk-multiple, custom.
- Exit policies: SL/target, positional exit, max holding, time-based, signal flip, decay, portfolio
  and group SL/target. The full ~50-value exit-reason vocabulary.
- **Full RMS**: all 28 breach types, hierarchical config, typed kill switches, rate trackers,
  breach log, daily stats.
- **Adapter contract test suite**, finalized and green for Zerodha and the paper broker.
- Console: RMS Config, RMS Breaches, Kill Switches, RMS Daily Stats, Trade Log + timeline.
- Crash-recovery tests: kill mid-fill, assert reconciled state or a clean halt.

**Exit criteria** — a supervised live session with one client, small size, real capital, clean
reconciliation across a restart.

---

## Phase 5 — The remaining brokers · size M

Fyers (v3), Dhan, Kotak Neo, each written against the contract suite.

**Exit criteria** — all four adapters pass the same suite unmodified; the suite catches a
deliberately broken adapter. Expect the contract to need revision here — that is the point of doing
it before external adapters exist.

---

## Phase 6 — Equity and MTF · size M

Stock universes and the NSE index-constituent loader; equity evaluator; equity sizing with leverage;
MTF product, funding and interest; holdings exit; equity tick routing; broker MTF mapping;
corporate actions with `ca_factor` sweeps. Console: Stock Universes, Corporate Actions.

---

## Phase 7 — Multi-leg and combos · size M

`ComboSpec`, per-leg roles, declarable entry and exit leg ordering, `combo_id` correlation,
combo-aware square-off, RMS and capital. Partial-failure compensation when one leg of an entry
fails — the gap Java's own TODO flags as unclosed.

**Exit criteria** — a combo executes end to end in paper mode, and a forced mid-entry leg failure
unwinds cleanly rather than leaving a naked leg.

---

## Phase 8 — Capital, charges, reports, analytics · size M

Allocation models and compounding; capital change history; brokerage plans and rates; statutory
charges with broker overrides; charge recompute; EOD P&L job (intraday, positional); positional
daily MTM + recompute; unaccounted P&L; aggregated P&L snapshots; the six analytics dashboards;
Excel export/import for strategy definitions and RMS config.

---

## Phase 9 — Packaging and operations · size M

Linux installer and upgrade scripts; Windows installer, upgrade and service wrapper; Docker compose
path; scheduled local `pg_dump` with retention; data retention jobs; system status; cache
management; audit log UI; alerts polish; installation manual for both platforms.

**Exit criteria** — a clean install on a fresh Windows box and a fresh Linux box, from the scripts
alone, plus an upgrade over an existing install that preserves data.

---

## Phase 10 — Opt-in backtesting · size S

`HistorySource` adapter for an operator-supplied history database; replay of that data through the
live evaluator → sizer → RiskGate → paper-broker path; enable/disable flag, off by default;
behavioural reporting with the data-quality caveats shown in the UI.

---

## Sequencing at a glance

```
0 Foundations
└─1 Vertical slice ─────────────────────────────────┐
   ├─2 Market data ──┐                              │
   ├─3 Strategy engine ─┐                           │
   └─4 Live + RMS ──────┴─5 Brokers                 │
                          ├─6 Equity + MTF          │
                          ├─7 Multi-leg             │
                          └─8 Reports ──9 Packaging ─┴─10 Backtesting
```

Phases 2 and 3 can proceed in parallel with each other once Phase 1 lands. Phase 4 needs both.
Nothing after Phase 4 is on the critical path to a usable engine.

---

## Risks

| Risk | Mitigation |
|---|---|
| Broker API drift during the build | Contract suite + recorded responses; adapters isolated behind one protocol |
| The rewrite quietly changes an exit decision | Deterministic replay in CI from Phase 1 |
| Decimal vs Java's `double` produces "wrong" numbers | Documented as intended (`DESIGN.md` §5.1); never reconciled by matching float |
| Frontend strip drags on | API shapes kept close to Java v2; strip in passes, per phase, not all at once |
| Scope creep back toward the Java feature set | `SCOPE_DECISIONS.md` is the gate; anything not in it needs an explicit decision |
| Kotak Neo login shape unknown | Deferred to Phase 5, after the contract is proven on three OAuth brokers |
