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
| **The API and the Console** | Empty packages. |

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
| 2026-09-01 | RMS finished: the breach log, scoped kill switches, order rate limits. Trailing finished bar one mode: the group's trailing stop, and ATR/EMA/SuperTrend off closed bars. Progress tracking written down. |
| 2026-08-31 | The strategy engine, end to end: rules, direction, selectors, strikes, indicators, synthetics, tranches, candle history. Then the risk gate wired in front of every order, exits gated on their own terms, limits resolved per order, the position cap, and combined stop and target. |
| 2026-08-29 | The composition root, the `exchanges.currency` and `segments` columns, and the Intent → TradeSignal seam. |
| 2026-08-28 | Project charter, scope, design documents, and the Phase 0 foundations. |

---

## Next

In value order. **Ask before starting anything with a Console page.**

1. **The API and the Console.** The biggest chunk left and the one that closes
   every phase. Proposed in [`API_AND_CONSOLE.md`](API_AND_CONSOLE.md) —
   26 pages to make work, 17 to delete, 7 to defer — and **not yet agreed**.
2. **`HEIKIN_ASHI` trailing.** The last trailing mode.
3. **Phase 4 leftovers that are not UI**: the adapter contract test suite, the
   order-fill escalation ladder, and the four exit policies above.
