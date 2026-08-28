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

- **No XTS**, no Noren, no IIFL, no UTrade, no 5paisa, no TrueData for now. XTS revisited later.
- The adapter seam must keep adding a broker cheap — that is the point of the contract test suite.

## 4. Broker login

- **No auto-login.** No TOTP automation, no scheduled session refresh, no credential storage for
  unattended login.
- Login is operator-initiated only: the admin clicks "Login" on a trading client in the UI, and the
  normal OAuth redirect or direct API login runs.
- Session expiry surfaces as an alert and halts trading for that client; it never self-heals.

## 5. Strategy configuration

- **Collapse the Java 3-level config tree.** Keep one **day override** layer over the strategy's
  base configuration. Two distinct mechanisms, both retained:
  - **Day-type config override** — overrides *any* strategy property (SL, trailing SL, combined SL,
    entry time, …) by day type: weekday and expiry day / days-to-expiry.
  - **Event days** — a dated table (budget day, election day, …) that scales *capital allocation*
    only: on that date a strategy trades 5 or 3 lots instead of its usual 10. Pre-configured
    per date, applied automatically.
- Strategy definitions, templates and per-trading-client subscriptions stay.
- **Hedging enable/disable moves from tranch level to strategy level.**

## 5a. Strategy templates — composed, not subclassed

The reference engine's template hierarchy is not ported. Its inheritance tree spends single
inheritance on "template" and then threads every other axis through by hand, which is why adding
an option-buying mode meant seventeen edits inside one evaluator and why combos ended up a sibling
of advanced options rather than a configuration of it.

Garuda has **one concrete evaluator** driven by a validated `StrategySpec` — legs, instrument
selectors, side rules, triggers and exits as data. Templates become named presets of that spec.
See `DESIGN.md` §10.2.

Consequences:

- **All combinations are first-class**: equity + options, equity + futures, futures + options,
  covered calls, cash-future arbitrage, multi-leg combos. Each is a different set of legs, not a
  different class.
- The reference engine's `TradeMode` enum disappears. Selling options is a side rule on an option
  leg; buying them is the opposite side rule; futures and equity are different selectors.
- **The two custom-logic templates are dropped entirely** — not ported, not reimplemented. Core
  ships no bespoke evaluator. A third party can register one through the `garuda.evaluators`
  entry point if a spec genuinely cannot express their logic.

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

Kept where it might have looked droppable:

- **Algo-vs-broker comparison / reconciliation** stays as-is (position mismatch reporting).
- **Excel export/import** of strategy definitions and RMS config stays — operators share strategies.

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
