# Garuda Engine — progress tracker

**Updated:** 2026-09-01

The living record of what has landed. `IMPLEMENTATION_PLAN.md` says what we
intend to build and in what order; this says what exists today, what is still
vocabulary, and what comes next.

**Keep this current.** Update it whenever a chunk of work lands — a commit or
a run of related commits — in the same change, not afterwards. A tracker
brought up to date once a week is a tracker nobody trusts. Two rules keep it
honest:

- **Say what is not built, not only what is.** A feature is not delivered
  because a table, an enum member or a config column exists for it. The
  section on vocabulary below is the most useful part of this file.
- **One fact, one place.** Where a design document already explains something,
  link to it rather than restating it.

---

## Where we are

**The engine is through Phase 3 and well into Phase 4. Nothing that has a
Console page has been started.** `api/` holds one empty `__init__.py` and
`frontend/` is empty, so by the plan's own rule — *a phase is not done until
its Console pages work against the real backend* — no phase past 0 is closed.

Everything below the API line runs. `garuda seed`, `garuda check` and
`garuda run` build the whole engine, load strategies, evaluate rules, size and
place orders, manage open positions and square off.

| Phase | State | What is missing |
|---|---|---|
| 0 Foundations | **Done** | — |
| 1 Vertical slice | Engine done, no UI | The API and the frontend strip. Everything else runs, including the paper broker, the order state machine, the journal and replay. |
| 2 Market data | Partly | Fyers and Dhan feeds; `FeedRouter` and provider failover; Console pages. Synthetics, option chains, expiries, Black-Scholes and candle history are done. |
| 3 Strategy engine | Largely done | Console pages; cross-day strategy state. Specs, config resolution, rules, direction, selectors, indicators, tranches and hedging all run. |
| 4 Live execution and RMS | Substantially done | The adapter contract suite; the order-fill escalation ladder; four exit policies; Console pages. |
| 5–10 | Not started | — |

Catalogue: **12 rules · 6 selectors · 7 direction rules · 11 indicators ·
5 synthetics · 15 RMS checks**.

---

## Built and running

**Foundations** — layer contracts enforced by import-linter; `Decimal`-only
money paths and the clock discipline both lint-enforced; mypy strict; the
domain model and its property tests.

**Persistence and recovery** — the schema and its migrations, the seed loader,
the append-only journal in the same transaction as the row it describes,
startup reconciliation that halts rather than auto-corrects, and the trade
store that survives a restart.

**Market data** — the Zerodha instrument master and tick feed; the tick hub;
the instrument registry with expiry and strike selection; candle history
fetched from the broker and cached in memory; five synthetic instruments
(rolling straddle, PCR, synthetic future, implied volatility, IV skew);
Black-Scholes and an implied-volatility solver.

**Strategy engine** — strategies composed from specs and configuration rows
rather than subclasses; four-scope config resolution merged per field; a rule
engine with three-valued outcomes (pass, fail, **unavailable**); 12 rules,
7 direction rules, 6 selectors, 11 indicators; tranche lifecycle; strike
selection by moneyness and by premium; an adapter that reads the Console's own
`operator`/`condition` rule JSON.

**Order and trade management** — the order state machine with client order ids
and idempotency; entry, protective and square-off services; freeze-quantity
slicing; the per-tick pass over open positions; per-leg trailing (risk
multiple, ATR, EMA, SuperTrend) and trail-to-cost; combined stop, target and
trail across a group, with the group's high-water mark persisted on its legs.

**Risk** — the gate in front of every order, entries and exits alike, with
each check declaring whether it may stop an exit; limits resolved per order
across all four `rms_config` scopes; 15 checks; scoped kill switches; order
rate limits; every refusal recorded in `rms_breach_log`.

---

## Named but not built

The most useful section here. Each of these has a table, an enum member or a
configuration column, and nothing behind it. They are named so a ported
configuration is refused loudly rather than silently ignored.

| | |
|---|---|
| **14 of 29 breach types** | `PRICE_FREAK`, `VOLATILITY_CIRCUIT`, `MARGIN_INSUFFICIENT`, `DEPTH_INSUFFICIENT`, `POSITION_TOTAL_EXCEEDED`, `POSITION_PER_STRATEGY_EXCEEDED`, `COMBO_TOTAL_EXCEEDED`, `BROKER_STOPPED`, `ERROR_RATE_CIRCUIT`, `PRICE_DEVIATION`, `PRICE_NOT_TRADED_TODAY`, `DUPLICATE_EXIT_ORDER`, `EXIT_RATE_EXCEEDED`, `ORDER_OPERATION_RATE_EXCEEDED` |
| **4 exit reasons** | `MAX_HOLDING`, `SIGNAL_FLIP`, `PORTFOLIO_STOP_LOSS`, decay |
| **1 trailing mode** | `HEIKIN_ASHI` — needs a candle transform, a wick search and a distance cap that nothing else uses |
| **Automatic kill switches** | Operator-set switches load and fire. The reference also raises them from a daily loss, a volatility circuit or a rejection rate, with a state machine for when one may re-fire. `DailyLossCheck` refuses at the limit instead. |
| **The `*_policy` tables** | Not read, and that is correct: they are Console-side templates with no key from a strategy. See `TRADE_MANAGEMENT.md`. |
| **Most of the API** | Serving now: config, login, profile, change-password, health, exchanges, holidays, special trading days, event days, symbols and stock universes (full CRUD). Every other page still calls endpoints nothing serves. `GET /api/exchanges/market-status` is the one exchange route still missing: it needs the built trading calendars, which live in `composition` — above `api` — so it lands with the Terminal, its only caller. |
| **Stock universes** | Both tables and `strategy_definitions.universe_id` exist and the endpoints serve them; nothing resolves a universe into subscriptions. That is engine work belonging with the strategy pages. |
| **`PREDEFINED_INDEX` universes** | Accepted, but garuda has no NSE CSV pipeline, so such a universe holds whatever was last written by hand and its `last_refreshed_at` never moves. `CUSTOM` is the usable type today. |
| **Users, in the Console** | The pages that scope by *user* -- the user selector, event days, recompute, subscriptions, the config tree -- still speak of users. In garuda that concept is the trading client, and the rename waits on the API defining its shape. |

---

## Deliberate departures from the plan

Recorded in `SCOPE_DECISIONS.md`; listed here so the two do not drift.

- **No `EXTERNAL_SIGNAL` and no second rule engine in market data.** Market
  data publishes synthetic *instruments* and the strategy's own rules read
  them. `STRATEGY_RULES.md` §6.
- **Candle history is cached in memory, not Postgres.** Settled days fetched
  once, today refreshed when stale.
- **11 indicators, not 16.** The absent five are ones no configured strategy
  in the reference uses, and adding one costs no rule.

---

## Log

Newest first. One line per chunk of work, not per commit.

| Date | What landed |
|---|---|
| 2026-09-01 | Stock universes served: CRUD plus members, where a member has to be a symbol curated on the Symbols page. Nothing in the engine resolves a universe yet — `strategy_definitions.universe_id` is the hook and it has no reader — so this is a list an operator can curate and nothing trades from. |
| 2026-09-01 | Symbols served: list, fetch, create, partial update, delete, and the per-broker freeze-limit sub-resource. This is the first page whose table the engine already read, so the endpoints refuse exactly what `SymbolInfo` refuses — a skipped row is a strategy that never finds its instrument. |
| 2026-09-01 | Event-day endpoints for both levels, and bracket/cover orders removed from the codebase — garuda places neither, so `ProductType.BO`/`CO`, the Kite variety routing, the `bo_co_blocked` columns on `event_days` and `brokers`, and the Console's `isBOCOBlocked` fields and help are all gone. |
| 2026-09-01 | Seeded special trading days: the FY2026 Union Budget on Saturday 01-Feb-2025 (NSE, BSE, usual hours), Diwali muhurat 21-Oct-2025 (NSE, BSE, 13:45–14:45 over a holiday), and Holi 14-Mar-2025 where MCX trades 17:00–23:30 and the equity venues do not. One row of each shape the table exists for, pinned by tests that read the calendar rather than the rows. |
| 2026-09-01 | A help panel on Special Trading Days: the ordering the engine actually uses, and the three cases — a full session on a weekend, one exchange open while the others are shut (MCX evening on a national holiday, which needs a Holidays row *and* a special day), and a muhurat hour. Every claim in it was checked against the calendar. |
| 2026-09-01 | Special trading days, end to end: a new `special_trading_days` table, the venue loader feeding the calendar's `special_sessions` (which existed and had nothing feeding it), and the CRUD the page needs. Budget day on a Saturday trades the venue's usual hours; Diwali muhurat carries its own. |
| 2026-09-01 | Holidays served: list per exchange, create, edit the description, delete. A holiday against an exchange that does not exist is refused, because the venue loader groups them by code and one that matches nothing leaves the day open. And the page's Add and Delete buttons appeared for the first time — they were gated on a `canEdit` prop defaulting to `false` that nobody passed, the permission strip's leftover; the same defect was in Special Trading Days and Symbols. |
| 2026-09-01 | Timezone on the exchanges form is a searchable select over every IANA zone the server knows, grouped by region, and an unknown zone is refused at the API instead of raising in `ZoneInfo` at startup. |
| 2026-09-01 | Currency and segments on the exchanges page — table, form and view — with the option lists served from the engine's own enums rather than copied into the UI. Both are now refused at the API when they are wrong, because the venue loader refuses them at startup, which is a long way from the form that typed them. |
| 2026-09-01 | One flat `/api`, and the first page served for real. The Console called three prefixes it inherited — `/apis` (v1), `/api/v2` and a couple of bare ones; there is one API here, so a version in the path says nothing. Exchanges is the first page whose endpoints exist: list, fetch, create, partial update and delete, with 18 behavioural tests. The SSO handshake went with it (token, refresh, userinfo, the OAuth config) — unreachable, since sign-in issues one access token and nothing else. |
| 2026-09-01 | Type: DM Sans for body, Sora for headings, JetBrains Mono for figures, and a root of 16px instead of 15 with the scale shifted up a step — the console was set at 14px body, which is too small to read a table of money in. |
| 2026-09-01 | The Console's first page is a setup guide instead of a dashboard: six stages in the order they have to happen — venues, instruments, brokers, accounts, risk, strategy — each linking to the page that does it, with the reason it comes where it does. The nav sections and the pages inside them are in that same order rather than the alphabet. The dashboard it replaced is deleted, not parked: it was tiles of "no data available" against endpoints that do not exist. |
| 2026-09-01 | The Console dropped its left rail. Navigation is now a top bar carrying the seven sections and a row under it carrying that section's pages, so the wide tables get the full width of the window; the Terminal runs full screen with the bar and nothing else. The palette is the sign-in page's throughout — sky/indigo/purple over near-black, dark by default, with its grid and soft lights behind the content. Removed on the way: the trade checklist, the AI assistant (both of them named as out of scope), and the dashboard's billing card, which was still fetching an endpoint that will never exist. |
| 2026-09-01 | A mark: Garuda is the eagle Lord Venkateshwara rides, so it is an eagle with its wings spread. Two cuts — the bird in the lockup, and a solid-winged one that survives the favicon, since layered flight feathers turn to mush below about 40px. Inline SVG, so the wordmark takes `currentColor`; the `logo`/`logoSmall`/`logoUrl` config fields nothing read any more are gone, and so is a `prebuild` hook left over from the reference app that pointed at scripts this repo does not have and broke `npm run build` outright. |
| 2026-09-01 | An API that can be signed in to: one admin, password in `system_config`, changeable from the Console. Permissions and the user portal cut out of the Console entirely. The Console copied from the reference and stripped: one brand, one deployment, one local admin, no SSO, no billing, no user portal. 30 pages, builds clean, and a CI gate that fails on the reference engine's name. RMS finished: the breach log, scoped kill switches, order rate limits. Trailing finished bar one mode: the group's trailing stop, and ATR/EMA/SuperTrend off closed bars. Progress tracking written down. |
| 2026-08-31 | The strategy engine, end to end: rules, direction, selectors, strikes, indicators, synthetics, tranches, candle history. Then the risk gate wired in front of every order, exits gated on their own terms, limits resolved per order, the position cap, and combined stop and target. |
| 2026-08-29 | The composition root, the `exchanges.currency` and `segments` columns, and the Intent → TradeSignal seam. |
| 2026-08-28 | Project charter, scope, design documents, and the Phase 0 foundations. |

---

## Next

In value order. **Ask before starting anything with a Console page.**

1. **The API.** The Console is stripped and building; nothing serves it. This
   is now the only thing between the engine and a usable product. See
   [`API_AND_CONSOLE.md`](API_AND_CONSOLE.md).
2. **Repoint the Console at the new API**, and inline the permission checks.
   The pages still call the reference's endpoints and still branch on a
   permission shim.
3. **`HEIKIN_ASHI` trailing.** The last trailing mode.
4. **Phase 4 leftovers that are not UI**: the adapter contract test suite, the
   order-fill escalation ladder, and the four exit policies above.
