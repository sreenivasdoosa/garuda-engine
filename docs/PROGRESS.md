# Garuda Engine — progress tracker

**Updated:** 2026-10-10

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

**The engine is through Phase 3 and well into Phase 4. The Console is
served for the market group and half of the accounts group.** Fourteen
pages work against the real backend — auth, config, health, exchanges,
holidays, special trading days, event days, symbols, stock universes, data
providers, market data, the Live Feed, trading clients and brokers. Broker
Config, RMS, strategies, subscriptions, trade log, alerts, reports and the
admin pages still call endpoints nothing serves, so by the plan's own rule — *a phase is not done until its Console
pages work against the real backend* — no phase past 0 is closed.

Everything below the API line runs. `garuda seed`, `garuda check` and
`garuda serve` build the whole engine, load strategies, evaluate rules, size
and place orders, manage open positions and square off, and serve the Console
and its socket from the same process.

| Phase | State | What is missing |
|---|---|---|
| 0 Foundations | **Done** | — |
| 1 Vertical slice | Engine done, no UI | The API and the frontend strip. Everything else runs, including the paper broker, the order state machine, the journal and replay. |
| 2 Market data | Mostly | Fyers, XTS and TrueData feeds; `FeedRouter` and provider failover. Zerodha and Dhan carry data, synthetics are stored and charted, the Live Feed runs on live ticks, and the ticker and the instrument files have Console controls. |
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
| **Market data from the four new providers** | Configuration, login and session storage work for Zerodha, Fyers, Dhan, XTS and TrueData. **Dhan is now complete as an adapter**: scrip master, catalogue, REST quotes, today's OHLC, candles and the binary websocket feed. What is *not* built: Fyers' HSM binary framing, XTS's Socket.IO, TrueData's websocket, and the masters, quotes and history for those three. |
| **A trading client's login does not refresh the instrument files** | A *data provider's* login does, through `renew_after_login`. The Trading Clients page has no API yet, so the broker-side login that should do the same has nowhere to hook in; it lands with that page. |
| **Quotes have no caller** | `QuoteSource` is a protocol, Dhan implements it, and `quote_factory` now reaches it — but nothing in the engine pulls a quote yet. The pipeline still prices from the last tick. The fallback-when-the-feed-is-stalled path the protocol describes is not built. |
| **Users, in the Console** | The pages that scope by *user* -- the user selector, event days, recompute, subscriptions, the config tree -- still speak of users. In garuda that concept is the trading client, whose wire shape `/api/trading-clients` now defines; the rename of those pages is still to do. |
| **A login after start does not make an account trade** | The engine builds each trading client's broker, book and loop at startup from the session it finds then. A login made in the Console reaches the *feed* and candle history at once (the resolver re-reads and the next connect carries the new token), but an account that had no session at startup gets its trading parts only on restart. The reference built its login sessions lazily per user; porting that is the next piece of the Trading Clients work. |
| **Broker Config and Broker Instruments** | The two remaining pages in the Accounts group call endpoints nothing serves. `broker_exchange_config` has a table and nothing reads it (see the next row); the instrument statistics the other page shows are the download registry's, not yet served under its route. |
| **Order protection is not applied** | `MarketProtection` -- market orders converted to marketable limits, stop triggers kept a gap from their limits, per broker and venue from `broker_exchange_config` -- exists in `ordermgmt/protection.py` with its own tests, and nothing in the composition root constructs it: the only `OrderManager` built with one is the test harness's. Until it is wired, every order leaves exactly as the strategy shaped it. Belongs with the Broker Config page, which is where the rows it reads are edited. |
| **A stopped broker stops its accounts at the next start** | `brokers.enabled` and `brokers.stopped` are honoured when the engine builds its accounts, so a broker switched off on the Brokers page has no account built at it, by name. Stopping one while the engine runs writes the row and changes nothing until restart; the kill switch is the runtime brake. |

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
| 2026-10-10 | **Brokers served.** `/api/brokers`: list, fetch, partial update, stop, unstop, usage and delete, plus `/types` for the page's picker. Ported from `BROKERS` per column: enabled, stopped, description, provider, dealer APIs, socket flag, API version, server start and stop times, the two update intervals, NAIC code, algo id and the MTF rate are editable; the vendor's endpoints (`SERVER_URL`, `DATA_SERVER_URL`, `OAUTH_URL`, the host-lookup fields, the socket.io version) are served and refused on change, because a URL is a fact about someone else's API and belongs in code (`CLAUDE.md` rule 8). Dropped: `AUTO_LOGIN` and `TOTP_ENABLED` (no unattended login), `USE_COMMON_APP` and the common app key and secret, `MARKET_DATA_APP_KEY` and secret (the Data Providers page holds those, encrypted), `XTREME_AGENT_DEST_URL`, `HOST_LOOKUP_PASSWORD`, `MARKETDATA_LOGIN_PATH`, `INSTRUMENTS_PATH`, and the already-removed `BO_CO_BLOCKED`. **Nothing can be created:** a broker is an adapter garuda ships and the four rows are seeded, so `POST` says so. Delete is refused with the usage -- trading clients, exchange configs, symbol limits -- while anything refers to the broker, the reference's shape. **The two switches reach the engine:** an account at a disabled or stopped broker is not built, with the reason by name, at the next start. In the Console the Brokers page is titled as such, its Add button is gone, and the nav no longer calls it Trading Clients. Run against the real engine: list, stop, unstop and usage. **Not built:** a stop while the engine runs takes effect on restart; Broker Config and Broker Instruments are still unserved; and order protection from `broker_exchange_config` is not wired at all (see above). |
| 2026-10-10 | **Trading clients served, and a login reaches the running engine.** `/api/trading-clients`: list, fetch, create, partial update, delete, login, logout, with the login status merged into each account because the page asks one question -- can it trade right now. Ported from `USER_BROKERS_MAP` per column: name, broker, client id, enabled, app key and secret (encrypted), pro flag, dealer-API override, socket flag, `USE_API_OF` as `usesCredentialsOf`, the whitelisted address in place of the agent URL; dropped: password, PIN, TOTP key, PAN (no unattended login, `SCOPE_DECISIONS.md` §4), auto-login, brokerage plan and allocation model (they belong with capital), licence and seat. The id is a slug of the display name, fixed at creation. The login is a browser redirect for Zerodha (through the broker's own auth, which refuses a session for a different client id and keeps the public token), Fyers and Dhan; Kotak says it is not built. A failed login's reason is kept on the row, as the reference does. **Fixed on the way:** the callback for a provider *borrowing* a trading client's credentials stored the token as a provider session, which nothing read -- the Data Providers page kept saying logged out. The callback now writes the trading client's own status when the owner segment names one. **The engine follows a login without a restart:** `reload_sessions` re-reads trading clients, broker sessions and the provider table into the running resolver; the feed resolves who is logged in at every connect rather than once at build; candle history rebuilds its adapter when the token changes. A second defect fixed there: a nominated provider that had not logged in fell back to the account's *token* but kept the provider's *name*, which would have opened a Dhan socket with a Zerodha token. **In the Console:** a Trading Clients page under Accounts -- table with session state, since, flags and reason for a failed login; add and edit; Log in, Log out, Enable, Disable, Remove; the redirect URL to register with the vendor. The nav item that said "Trading Clients" but opened the Brokers table now says Brokers. Run against the real engine: list, create, login URL and delete. **Not built:** an account that had no session at startup trades only after a restart (the feed and candles do not need one); Brokers, Broker Config and Broker Instruments are still unserved. |
| 2026-10-10 | The ticker and the instrument files are under the operator's hand, and a login fetches today's master. Every instrument file -- the Zerodha master and each provider's catalogue -- now loads through one `InstrumentDownloads` registry, so the day's DAY_INIT tasks, a provider login and the Console's button all run the same load and the status the Console shows is the one that actually happened: count, when the file was fetched, whether it is from today and whether it predates 08:00, the last attempt and why it failed. Two rules ported from the reference's `fetchAndLoadInstruments`: a failed fetch is not retried for ten minutes unless asked for by name, and a forced download ignores the cache. The day's tasks are not throttled, because the runner is already the retry there. **On a provider login** the files are refreshed and *then* the feed replaced, in that order, in the background -- the reference's "login first" rule, which is what turns a login after the open from a session on yesterday's strikes into one on today's. **In the Console**, the Data Providers page gained a Ticker card (connected / disconnected / stopped, provider, last tick, quoting of subscribed, reconnects; Start, Stop and Restart, each confirmed first, a manual start deliberately not holiday-gated) and an Instrument files card (one row per file, modelled on the reference service's Instruments admin page: status, count, file date, last attempt, Download). Both poll every five seconds. Routes: `GET /api/market-data/ticker`, `POST …/ticker/{start,stop,restart}`, `GET /api/market-data/instruments`, `POST …/instruments/{name}/download`. Run against the real engine: the master loads through the registry at startup, restart brings the feed up, an unknown file is refused by name. **Not built:** a *trading client's* login does not refresh the files, since that page has no API yet; and the Broker Instruments page in the Accounts section still calls endpoints nothing serves. |
| 2026-09-02 | The Live Feed works, end to end, with live Zerodha ticks. Five tabs -- indices, rolling straddle, implied volatility, put-call ratio, synthetic future -- over the one `/socket`; Signals is gone, being a strategy's private reasoning rather than market data. Charts open in a bottom drawer and are the *same* `CandlestickChart` the indices use, because a derived series is served by the same history route under its own instrument id (`SYNTH:STRADDLE-NIFTY`), folded from stored minutes to whatever interval is asked for. The synthetic-future chart compares against the spot and the near-month future, each on its own price scale, following the candle/line toggle. Series are enabled and disabled **at runtime**: symbols live in a swappable `SymbolBook`, the Symbols page reload is injected by the composition root, and the sweep rebuilds the sources when its version moves. Seeded on by default for NIFTY, SENSEX and CRUDEOIL -- one per exchange, so a fresh install exercises NSE, BSE and MCX. **Nine defects fixed, every one of them silent.** Nothing read the feed's event stream, so ticks piled up unread in an async generator (`hub.consume()` had no caller); the supervisor replaced the feed every five seconds because "no tick yet" counted as a stall, with no grace from connect and no notion of market hours; `spot()` read the underlying's own id rather than the instrument its level arrives on; the chain was never subscribed for a derived series, and when it was, by the price carrier rather than the underlying; the expiry kind was hardcoded weekly, and the expiry lists mixed futures with options, so MCX resolved a date with no options on it; the storage guard used one venue's window for every symbol and asked for the engine's *next* trading day, which stopped every bar the moment the first venue closed; a phase failure was recorded and never logged, hiding an instrument master that could not load; and `ZerodhaHistory` formatted Kite's range without converting to IST, truncating five and a half hours off every request. **Not built:** instruments are not downloaded on login when the day's are missing, and there is no Console control to start, stop or restart the ticker or to trigger a download. |
| 2026-09-02 | One process, and a socket. `garuda serve` now builds the engine and serves the Console over it, which is what `DESIGN.md` always specified: a tick lives in the hub for an instant and is never written anywhere a second process could read in time, so an API served apart from the engine can show configuration and history and nothing that moves. `--reload` still serves the API alone and says so. A Postgres advisory lock refuses a second engine on one database -- two would read the same subscriptions and place the same orders, each behaving correctly while doing it -- and dies with its connection, so a crash needs no cleanup. `/socket` is one multiplexed endpoint taking the `{method:'subscribe',subList:[...]}` frame the Console already sends; ticks flow today, Terminal and alerts share it later. Prices cross as strings, because JSON has only floats and 123.45 becomes 123.44999999999999 at the last place anyone looks. Market-data REST serves health, indices, quotes, the three per-series tick routes and history for both broker candles and the four derived tables. Every curated index on an enabled exchange is now watched from the open, by whatever actually carries its price: the index's own feed symbol, or -- ported from the reference's futures reference symbol -- the current-month future, because MCX publishes no CRUDEOIL level and subscribing to the bare name subscribes to nothing at all. Three defects found by running it: a phase failure was recorded and never logged, so a DAY_INIT that could not load the instrument master left an engine that connected, subscribed to nothing it could resolve, and reported itself healthy; `_strategy_loop` returned None whenever nothing was subscribed, so a fresh install had no watchlist at all; and the default `app_home` is not writable by a developer account. **Not built:** the Live Feed page itself, and no ticks have been observed end to end yet. |
| 2026-09-02 | The derived series get a past. Five series the engine already priced — rolling straddle, put-call ratio, synthetic future, and both implied-volatility legs — are now folded into one-minute bars and stored, in four tables keyed `(symbol, bar_start)` and typed `NUMERIC(20, 6)` throughout. Which underlyings compute them is per symbol: `derives_straddle`, `derives_pcr`, `derives_iv`, `derives_synthetic` and `pcr_strikes_each_side` on `symbols`, all off by default, so an install that has asked for none of it walks no chain and writes no rows. `for_symbols` reads those flags instead of strategy subscriptions — a straddle should be chartable without someone trading it. The folding is ported from the reference service's `StraddleUtility`, including the rules that cost it: the bar's minute comes from the tick's own timestamp rather than a fresh clock read, the whole minute is compared and not the minute number, a quiet minute produces no bar, and the next bar opens at the next tick rather than the last close. Added beyond it: closing the final minute of the session, which the reference never writes. Implied volatility keeps publishing the two-leg *average* as its tick — that is what a threshold is written against — while a separate `IVReading` carries both legs, their strikes and the spot to the table, which is what a volatility chart shows. **Not built:** nothing serves these over HTTP or a socket yet, so the Console still cannot read them. |
| 2026-09-02 | Dhan is reachable: the composition root now loads the Data Providers rows, builds each provider's adapters from its *own* key, token and client id, and registers a DAY_INIT task per configured provider that downloads and publishes its catalogue — cached on disk, re-downloaded only once the day's master is published. The two active settings now genuinely select, and each falls back to the account nominated on the Trading Clients page when its provider is unset or not logged in, so installs predating the page are untouched. Ticks and candles can come from different providers. A catalogue that fails to load is contained: it costs that provider, not DAY_INIT. Fixed on the way: `DhanCatalogue` raised on any index row — Dhan publishes the index as `NIFTY 50` and an instrument id may not contain whitespace — so no catalogue was ever built and Dhan could carry nothing. The reduction now lives in the domain, because the broker master the engine matches against has to reduce the same name the same way. |
| 2026-09-02 | Dhan carries data: REST quotes (posted per segment, both non-bearer headers), today's bar out of the same call, candles from the two chart endpoints with their two date formats and columnar response, and the binary websocket feed — indices in QUOTE mode and tradables in FULL, batched at a hundred, with the connection cap checked before anything is sent. A `DhanCatalogue` translates instruments to Dhan's segment/security-id pair and back from a packet header. The packet decoder's segment table was three short, MCX among them. Not wired into the composition root yet: the adapters are registered and nothing supplies their arguments. |
| 2026-09-01 | Data providers: the `data_providers` table with credentials, ports and rate limits all in the database, an encrypted session per provider, the two active settings, operator-initiated login for all five (redirect for Zerodha/Fyers/Dhan, direct for XTS/TrueData), the callback, and the page. A provider that borrows a trading client has no session of its own — it reports that client's — so one login shows on both pages. Dhan's binary tick decoder is ported line-for-line, indices included. The tickers, quotes and history for the four new providers are not built yet. |
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

1. **The rest of the API**, one page at a time. Serving so far: config, auth,
   health, exchanges, holidays, special trading days, event days, symbols,
   stock universes, data providers, market data, the ticker and instrument
   files, trading clients and brokers. Everything else still calls endpoints
   nothing answers. Next in the accounts group: Broker Config, which is also
   where order protection gets wired in; then building an account's trading
   parts when it logs in after start. See
   [`API_AND_CONSOLE.md`](API_AND_CONSOLE.md).

2. **Read the stock universe in the strategy engine.** Both tables and
   `strategy_definitions.universe_id` exist, the endpoints serve them, and
   nothing resolves a universe into anything. The reference does it in
   `SubscriptionLoader`: a universe-bound definition expands to one
   subscription per member, for equity strategies and for universe-driven
   F&O/combo strategies alike. Until that lands, a universe is a list an
   operator can curate and no strategy trades from — so the work belongs with
   the strategy engine pages, not before them.

   Two things to settle when it does: whether an inactive universe means its
   subscriptions vanish or merely stop entering, and what happens to an open
   position when a symbol leaves the list mid-day. Neither has an obvious
   answer and both cost money if guessed.

3. **The users → trading clients rename in the Console.** The pages that scope
   by *user* still say so. Waiting on the API defining the trading-client wire
   shape.

4. **`HEIKIN_ASHI` trailing.** The last trailing mode.

5. **Phase 4 leftovers that are not UI**: the adapter contract test suite, the
   order-fill escalation ladder, and the four exit policies above.
