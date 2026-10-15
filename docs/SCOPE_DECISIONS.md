# Garuda Engine — Scope Decisions

Owner decisions, 2026-08-28. Authoritative over `JAVA_FEATURE_INVENTORY.md` where they conflict.
Garuda is a **Python rewrite of a mature Java algo-trading engine**, open-sourced under the
licence in `README.md`, standalone (market data in-process), single-operator.

---

## 1. Identity and shape

- Full-feature rewrite of the Java engine, with the tweaks below — not a clean-slate minimal engine.
- Open source, AGPL-3.0 + commercial, per `README.md`.
- Standalone single process: market data and trading core in one deployable.
- Runs on the operator's own PC or their own cloud box. No SaaS, no tenancy, no external services.

## 2. Accounts and access

- **One admin user** logs into the product (username + password). No roles, no permissions matrix,
  no per-tool gating.
- The admin manages many **trading clients** (the Java `USER_BROKERS_MAP` concept, renamed).
  - A trading client = display name + broker + client id.
  - `(broker, client_id)` is unique. Display name is unique and is what the UI shows.
  - Examples: `zerodha+CLIENTIDX`, `fyers+CLIENTIDY`, `zerodha+CLIENTIDZ`.
- The Java `USERS` / `USER_MANAGER_MAP` / user-portal concepts are gone.

## 3. Brokers and data providers

| Role | Supported |
|---|---|
| Broker adapters (execution) | Zerodha · Fyers (API v3) · Kotak Neo · Dhan |
| Market data providers | Zerodha · Fyers · Dhan |

- **No XTS**, and none of the other brokers or data vendors the reference supports, for now.
  XTS revisited later.
- The adapter seam must keep adding a broker cheap — that is the point of the contract test suite.

## 4. Broker login

- **No auto-login.** No TOTP automation, no scheduled session refresh, no credential storage for
  unattended login.
- Login is operator-initiated only: the admin clicks "Login" on a trading client in the UI, and the
  normal OAuth redirect or direct API login runs.
- Session expiry surfaces as an alert and halts trading for that client; it never self-heals.

## 5. Strategy configuration

- **The config tree keeps four scopes**: base, day condition, tranche, and tranche with day
  condition, merged per column. The reference's user and broker scopes are **out**: one operator,
  and a strategy that behaves differently on one account than another cannot be reasoned about.
- **Event days** — a dated table (budget day, election day, …) that scales lots only, applied
  automatically. **Day allocation** — per-strategy percentages by weekday and expiry proximity,
  keyed by strategy alone now that allocation models are out.
- Strategy definitions and per-trading-client subscriptions stay. **Templates do not** (§5a).
- `GLOBAL_SHARED` lot allocation is out; a lot budget is per day.

## 5a. Strategy engine — the reference's features, without its templates

Decided 2026-10-15; the design is `STRATEGY_ENGINE.md`. The reference's strategy layer is ported
**feature for feature**: its vocabulary, scheduled tranches, strike selection, direction providers,
lot allocation, breakout watches, adaptive tranches, re-entry, hedge windows and persisted state.
What is not ported is its template table and the seven evaluator classes keyed by it. Instead:

- **One pipeline with a hook per step**, in the reference's order, each hook defaulting to what
  the configuration says.
- **Four registries** — triggers, direction providers, strike selectors, indicators — so a new one
  is a registration.
- **Template behaviours become definition fields**: adaptive tranches and the 0DTE stop rules,
  indicator entry and exit, a re-entry mode, a direction provider for the five-day move, combo
  legs, equity sizing. Nothing a template did is lost; it is reachable from any strategy.
- **Custom strategies in code**: a subclass of the base overriding hooks, discovered by entry
  point or a plugins directory, named on the definition, refused if unknown, fail closed.

An earlier design (2026-08-28 to 08-31) replaced the reference's triggers, providers and breakout
watches with a rule engine and a leg spec. It was **withdrawn on 2026-10-15**: it dropped the
reference's behaviours along with its class hierarchy, and nothing built on it scheduled a tranche,
chose a strike by type, or sized a lot the way the reference does. Its resolver, day conditions,
indicators and rule translator survive inside the new design.

## 6. Paper trading (virtual broker)

- **First-class and required.** Mode is a property of the *strategy ↔ trading-client assignment*,
  not of the system: the same strategy can run **paper on client A and live on client B**
  simultaneously, in the same process, on the same signals.
- Mock trading / mock sessions / mock trading days / dummy ticker are **dropped** — a different
  feature, not this one.

## 7. Asset classes

Everything the Java engine supports, in full: **equity, MTF, options, futures, and all combos** —
including stock universes, equity sizing, MTF funding and interest, holding exits, corporate actions
and multi-leg / combo strategies.

## 8. Venues and time

- Designed for **multi-exchange, multi-timezone, world indices** from day one.
- Venue is data, not code: timezone, calendar, currency, tick/lot size, settlement and exercise
  style live on `Exchange` / `Instrument`.
- v1 ships NSE / BSE / MCX; the model must not need reworking to add CME or NYSE.

## 9. Dropped from the Java engine

| Dropped | Note |
|---|---|
| Billing | plans, bills, payments, referral codes, billing analytics, billing UI |
| Licensing | no license file, no license server, no license assigned to a trading client, no gate |
| Email | no templates, no branding, no preferences, no daily report mail — **nothing sends email** |
| Permissions / roles | single admin user |
| Auto-login | see §4 |
| Mock trading | see §6 |
| Scanners | BB squeeze, pivots, RSI quality, Supertrend first hour, intraday long-only F&O |
| Momentum scoring | |
| AI assistant | Claude provider, agentic investigation, SQL sandbox, docs/logs tools |
| Signal export outbox | and the dedicated signal-export user, and the strategy bridge |
| Xtreme agent | |
| DB backup to S3 | |
| Partial profit booking | designed but never built in Java; stays unbuilt |
| Telegram alerts | in-app alerts panel is the only channel |
| External P&L / external capital | no external-P&L tracking, no external capital fields |
| Unaccounted P&L | the table existed to reconcile billing; with billing gone it has no purpose |
| Custom-logic strategy templates | the two bespoke evaluators are dropped, not ported (§5a) |
| 1000-user optimizations | scaling package, sharding, load shedding, fan-out tuning, pool sizing |
| User portal | admin Console + Terminal only |
| Bracket / cover order tracking | brokers have withdrawn them (`brokers.bo_co_blocked`); `ProductType.CO`/`BO` stay so data round-trips, second-leg tracking does not |
| Candle stores on disk | The reference keeps SQLite databases of day and intraday candles. Garuda fetches history from the broker and caches it **in memory**: closed days once, today refreshed. Nothing is persisted, so there is no store to migrate, corrupt or reconcile |
| Building candles from ticks | Brokers publish history for every interval; reconstructing it from a tick stream is a second source for one number, wrong exactly across a restart or a dropped connection |
| Global shared lot allocation | `GLOBAL_SHARED` spread one lot budget across tranches and across days. A lot budget is per day and nothing else; `global_allocation_tranches` and `allocation_start_tranch` go with it |
| Leverage and max-risk-per-trade | both columns are set on no configured strategy; not ported |
| External signal trigger | **deferred, not out** (2026-10-15). The reference received signals as frames from its data feed; garuda will take them from an API endpoint and in-process conditions, with the same ENTRY and EXIT semantics. The event type exists from the start; the producer is in `TODO.md` |
| Strategy templates | the table, the capability flags and the template resolver. Decided out 2026-10-15: one pipeline whose hooks default to the configuration, and definition fields for what a template used to switch on (§5a) |
| Rules-as-triggers design | the 2026-08-31 proposal (`STRATEGY_RULES.md`, deleted) that collapsed triggers, providers and breakout watches into a rule engine. Withdrawn 2026-10-15 (§5a) |
| Positional daily mark-to-market | The reference marked carry-forward positions day by day and had a page to recompute it. Decided out on 2026-10-11: a positional trade books its whole P&L on the day it exits and is marked on no day before, so there is nothing to recompute; the Recompute Positional MTM page is gone |
| Strategy policies page | The policy tables are Console-side templates no strategy keys on (`TRADE_MANAGEMENT.md`); the page edited rows nothing read. Gone on 2026-10-11 |
| Recompute charges page | Removed from the Console on 2026-10-11 until the charges phase exists; a button over an unbuilt computation is a button that does nothing |
| Allocation models | The reference divided one capital pool across strategies by a named model (`ALLOCATION_MODELS`, `ALLOCATION_MODEL_STRATEGIES_MAP`). Decided out on 2026-10-11: a trading client subscribes to strategies directly, each subscription carrying its own capital, and the reports follow the same shape -- no overall base capital, no model. The two tables, their page and their fields on the subscription form are gone |
| Broker strategy config | The reference let one strategy's settings be overridden per broker (`BROKER_STRATEGY_CONFIG`). Decided out on 2026-10-11: a strategy's configuration has its four layers (`STRATEGY_CONFIGURATION.md`), and per-broker order handling lives on the broker's exchange config. No table, no page; the Broker Config page keeps its exchange configs and API stats tabs |

Kept where it might have looked droppable:

- **Algo-vs-broker comparison / reconciliation** stays as-is (position mismatch reporting).
- **Excel export/import** of strategy definitions and RMS config stays — operators share strategies.
- **Re-entry after a stop** (`re_entry_count`, `max_trades_per_stock`) stays.
- **Order fill escalation** stays — market after N seconds, or stepped through percentage buffer / level-N of the book / best bid-ask.
- **Hedge replace windows** stay — morning and evening switching of hedge distance, with restart recovery.
- **Corporate actions on open trades** stay — a split or bonus on a held position must leave P&L correct.

## 10. Frontend

- Copy the existing React/TS Console + Terminal and strip, rather than rebuild.
- Remove: user portal, billing, mock, license, permissions gating, email templates,
  symbol-broker-config, external-P&L fields.
- Keep the Python API response shapes close to the Java v2 API so the strip stays cheap.

## 11. Runtime and deployment

- Python, async, single process. Stack choices delegated to the implementer.
- **Windows and Linux both first-class**, each with install and upgrade scripts.
- **Docker additionally supported** where it makes the end user's life easier — not the only path.

## 12. Data

- **PostgreSQL only.** No SQLite, not even as a dev fallback — SQLite has no true DECIMAL type,
  serializes writers, and has no timezone-aware timestamps, all three of which this engine needs.
  Durability comes from a scheduled local dump shipped with the installer, not from the engine.
- **No data migration from the Java MySQL.** Fresh database, configuration re-entered — except
  seed reference data (exchanges, symbol configuration) which is carried over.

## 13. Backtesting

Supported, but **opt-in and data-source-driven**: the engine ships no bundled historical data and no
data loader of its own. If the operator has a history database they trust, they point Garuda at it
and enable backtesting; otherwise it stays disabled and paper mode against the live feed is the
validation path. The data-quality warning in `ARCHITECTURE.md` §1.1 stands as the reason it is
opt-in rather than default.

## 14. Frontend branding

- **No trace of the reference engine's branding anywhere** — not in code, config, docs, CSS
  class names, database identifiers, log strings or commit messages. One default brand:
  `garuda-engine`. The reference engine's four brand builds are removed.
- White-labelling stays possible for users who want it — theming, not a build matrix.

## 15. Repository layout

Monorepo mirroring the Java structure: `backend/` · `frontend/` · `scripts/` · `docs/`.

## 16. Phase 1 — end-to-end slice (agreed)

Admin logs in → adds a trading client (Zerodha, paper mode) → broker OAuth login → instrument
master loads → live ticks arrive → one simple strategy evaluates on a tick event → emits an intent
→ RMS passes it → paper broker fills it → position and P&L appear in the Terminal → the day's
journal replays byte-identically in a test.

## 17. Adopted design upgrades over the Java engine

1. Append-only journal as the source of truth for trades and positions.
2. Deterministic replay of a recorded day as a test mechanism.
3. Executable broker-adapter contract test suite from day one.
4. `Decimal`-only money and price paths, lint-enforced.
5. Behavioural tests only — no source-text pins.
