# The API and the Console — proposal

**Status:** Proposal · 2026-09-01 · not yet agreed
**Companion to:** [`DESIGN.md`](DESIGN.md) §13 · [`SCOPE_DECISIONS.md`](SCOPE_DECISIONS.md) · [`PROGRESS.md`](PROGRESS.md)

Everything below the API line runs. This is the last large piece, and the one
that closes every phase, because a phase is not done until its Console pages
work against the real backend.

`DESIGN.md` §13 already settles the shape: FastAPI under `/api/v2`, a
WebSocket at `/socket`, one `admin` identity with Argon2 and a short-lived
JWT, and the reference's React app copied and stripped rather than rewritten.
This document does not re-open those. It works out what §13 left as a
sentence: **which pages, which endpoints, in what order, and how faithful to
the old response shapes.**

---

## 1. What we are actually copying

The reference Console is **54 routes** plus a 15-route user portal. Its stack
is React 18, TypeScript, Vite, TanStack Query, Zustand, react-hook-form with
Zod, Tailwind, and three charting libraries.

Sorting those 54 against garuda's scope:

**Drop — the feature does not exist here (17)**
`users`, `user-bills`, `user-notes`, `user-brokers`, `user-subscriptions`,
`billing-plans`, `brokerage-plans`, `license-info`, `email-templates`,
`mock-cleanup`, `mock-trading-days`, `analytics/users`,
`analytics/user-performance`, `analytics/billing`, `symbol-broker-config`,
`data-retention`, `cache-management`.

Most are multi-tenancy or billing. Two need a note: `user-brokers` and
`user-subscriptions` do not disappear so much as *become* the trading-client
pages, and `symbol-broker-config` is deferred rather than dropped — it is the
second-broker feature the instrument registry already has a place for.

**Keep — 26 pages, the Console proper**

| Group | Pages |
|---|---|
| Accounts | Trading Clients, Broker Login, Brokers, Broker Config, Broker Instruments |
| Strategy | Strategy Engine (definitions, templates, tranche schedules, combo spec, rule builder), Strategy Config, Strategy Policies, Allocation Models, Subscriptions |
| Risk | RMS Config, RMS Breaches, Kill Switches, RMS Daily Stats |
| Market | Symbols, Exchanges, Holidays, Special Trading Days, Event Days, Data Providers, Live Feed |
| Operations | System Config, System Status, Alerts, Audit Logs, Trade Log and Timeline, Reports |

Plus `/terminal-admin` and `/login`, which are not under `/console`.

**Defer — real, but behind an unbuilt phase (7)**
`stock-universes` and `corporate-actions` (Phase 6, equity and MTF);
`statutory-charges`, `recompute-charges`, `recompute-positional-mtm`,
`run-eod-job` (Phase 8, charges and reports); `analytics/*` beyond the trade
and strategy views (Phase 8).

**Gone with the design (2)**
`signal-rules` and `strategy-rules-map`. There is no external signal here:
market data publishes synthetic instruments and the strategy's own rules read
them, so those two pages have nothing to configure. Their *content* moves into
the Strategy Engine's rule builder, which already emits JSON this backend
reads.

So: **26 pages to make work, 17 to delete, 7 to defer.**

---

## 2. How faithful the API should be

§13 says "response shapes close to Java's so the copied frontend needs minimal
rework". That is right where the two engines agree and actively wrong where
they do not, and it is worth being precise about which is which.

**Keep the shape** where the concept is unchanged: trades, positions, orders,
alerts, audit entries, exchanges, symbols, holidays, the terminal summary.
These are the pages with the most table-rendering code and the least logic; a
matching shape is pure saving.

**Change the shape** where garuda's model is different, and change the page
with it:

- **No users.** Every `username` + `broker` pair becomes one
  `trading_client_id`. This touches almost every endpoint, and pretending
  otherwise by synthesising a username would carry the reference's
  multi-tenancy into a single-operator engine.
- **RMS config is scoped, not levelled.** The reference's `config_level`
  column disagrees with its own scope columns often enough to be unusable —
  rows labelled `SYMBOL` with no symbol, `GLOBAL` naming an exchange. Garuda
  resolves by the populated columns and ignores the label. The page should
  edit scope, and show the resolved result for a chosen instrument, which is
  the question an operator actually has.
- **Strategies are specs, not templates.** `StrategyTemplates.tsx` renders a
  form per template name. Garuda composes from a validated spec with
  capability flags, so the form renders from capabilities.
- **Kill switches are scoped and typed.** Level, source, and a scope, rather
  than the reference's key-name string.

**One endpoint has no counterpart at all:** a *dry-run resolver* — give it a
strategy, a tranche and a day, and it answers with the resolved configuration,
the instruments the selectors would choose, and each rule's outcome with its
sentence. The engine already computes all of it; nothing surfaces it. It is
the difference between an operator debugging a strategy by reading the log and
debugging it by asking.

---

## 3. Order of work

The dependency is hard: nothing can be seen until an account can log in to a
broker, and nothing can be trusted until the Terminal shows what the engine
believes.

1. **Skeleton and auth** — FastAPI app, `/api/v2`, login, JWT, the error
   envelope, the audit-log middleware. One page: Login.
2. **Accounts and broker login** — Trading Clients, the OAuth callback,
   session state. The first point where the operator can make the engine do
   something.
3. **The Terminal and the socket** — positions, trades, P&L, alerts, live.
   The first point where they can see what it did.
4. **Strategy configuration** — Strategy Engine, Config, Subscriptions,
   Allocation Models, and the dry-run resolver beside them.
5. **Risk** — RMS Config, Breaches, Kill Switches. The breach log has been
   filling since 2026-09-01 and nothing reads it.
6. **Market and operations** — Symbols, Exchanges, calendars, Data Providers,
   Live Feed, System Config, System Status, Audit Logs, Trade Log, Reports.

Steps 1–3 are the vertical slice Phase 1 has been waiting on. Each step is a
working system: the API endpoints, their tests, and the pages that use them,
landed together rather than an API tier built ahead of any page.

---

## 4. Testing

The API is a layer over an engine that is already tested behaviourally, so its
tests are about the layer, not about trading:

- **Contract tests per endpoint** — status, envelope, and the shape the page
  consumes. Against a real PostgreSQL, as the store tests are.
- **Auth and audit** — every mutating endpoint requires a token and writes an
  audit row. Asserted once, generically, over the route table, so a new
  endpoint cannot forget.
- **The socket** — a client that falls behind is dropped rather than allowed
  to block the engine. This is the one place the API can hurt trading, and it
  is worth a test that a slow consumer does not stall a tick.
- **No snapshot tests of JSON.** They pin formatting rather than meaning and
  are the API equivalent of the source-text pins this project refuses.

---

## 5. Open questions

1. **Copy-and-strip, or start the Console fresh?** The plan says copy. Since
   it was written, more of the backend has diverged than expected — no users,
   scoped RMS, spec-based strategies — so a meaningful share of the copied
   pages would be edited rather than kept. Copying still wins for the rule
   builder, the design system and the charting, which are the expensive parts.
   Worth a decision rather than an assumption.

2. **How much of the 26 is actually wanted?** An operator running their own
   accounts may not need Audit Logs, Reports or Data Providers as pages at
   all. Cutting them now is cheaper than building them and finding out.

3. **Does the dry-run resolver earn its place in the first pass**, or is it a
   later addition? It is the most useful thing here that the reference does
   not have, and it is also not needed to trade.

4. **Terminal before or after strategy configuration?** The order above says
   before, on the grounds that seeing the engine is worth more than
   configuring it. The other reading is that a strategy cannot be run until it
   can be configured, so configuration comes first and the Terminal shows
   something real sooner.
