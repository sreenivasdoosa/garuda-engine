# Strategy engine — analysis and build order

Read `DESIGN.md` §10 first; it says *what* the strategy engine is. This says
what the reference engine actually does, what that means for the order things
get built in, and what has been decided along the way.

Written after reading the reference engine's configuration schema and the
shape of a real configured book. Nothing about that book — names, counts,
underlyings — belongs in this repository, so what follows describes weight
qualitatively and vocabulary exactly.

## 1. What the configuration actually looks like

> **Superseded in part.** `STRATEGY_RULES.md` replaces trigger types with
> rules. What follows still describes what the reference engine does and why
> the scheduler matters; it no longer describes what garuda will build.

### Entries are scheduled, not ticked

**No configured strategy uses a tick trigger.** Almost all use the scheduled
trigger; a minority use an external-signal trigger and a handful a periodic
one. This is the single most important thing the configuration says, and it
contradicts the obvious reading of "event-driven engine".

The consequence: **the dispatcher is a scheduler.** A strategy wakes at a
configured tranche time, resolves its legs, and emits intents. Ticks matter
after that — the entry service watches for the trigger price, the tracker
follows fills, trailing follows the extreme — but a tick is not what makes a
strategy decide to trade.

Building a tick-driven dispatcher first would have been building the path
nothing uses.

### One template does nearly all the work

Most strategies are one template: **scheduled option selling on an index,
in tranches, with a hedge.** The remaining templates are variations that add
an indicator entry, a different direction provider, or a different tranche
rhythm — not different shapes.

`DESIGN.md` §10.2 already decided that templates become data rather than
subclasses. The configuration supports that: what separates one template from
another here is which fields are populated, not what code runs.

Multi-leg combos configured through `combo_spec_json` are rare. The combo
machinery in trade management is built and tested and should stay, but combo
*configuration* is not what the first working strategy needs.

### The vocabulary, exactly

These are the values that actually appear. Anything not listed is in the
schema but unused, and should be refused loudly rather than guessed at.

| Field | Values in use |
|---|---|
| `day_condition` | `E` (expiry day) · `DT1` (day before expiry) · unset |
| `strike_type` | `MoneyNess` · `PremiumRange` · `PremiumRange_OIRanked` · `FixedPremium` · `CandleLow_NearPremium` |
| `strike_value` (MoneyNess) | `ATM` · `ITM-1` · `ITM-2` · `OTM+1` · `OTM+2` |
| `trail_sl_type` | `RISK_MULTIPLE` |
| `exit_mode` | `MINUTES_FROM_ENTRY` · `DAYS_FROM_ENTRY` · `EXPIRY` · `SAME_DAY` |
| `lot_allocation_mode` | `GLOBAL_SHARED` · `DAY_LOCAL` |
| `risk_calculation_mode` | `STOP_LOSS` · `WING_WIDTH_MAX_LOSS` |
| `breakout_watch_type` | `OPTION_SYMBOL` |
| `breakout_trigger_mode` | `PERCENTAGE` · `CANDLE_LOW` |
| `direction_provider_type` | `CANDLE` · `INDICATOR` · `IV_SKEW` · `PCR` · `N_BARS_BREAKOUT` · `FIXED` · unset |
| `trade_mode` | `OPTION_SELLING` · `OPTION_BUYING` · `EQUITY` · `FUTURES` · `FUTURES_OPTIONS` |
| `product` | `INTRADAY` · `POSITIONAL` · `CASHBUY` |

Two things worth noting. **`MoneyNess` with `ATM` is by far the most common
strike rule** — most positions are at the money, and the offsets are the
exception. And **`RISK_MULTIPLE` is the only trailing type configured**: the
indicator-based trailing modes that trade management refuses with an alert
(ATR, EMA, SuperTrend, Heikin Ashi) are not used, so that refusal costs
nothing today.

### Configuration is resolved per column, not per row

`strategy_config` holds rows at four scopes, and the database computes how
specific each is:

| Scope | Keyed by | Priority |
|---|---|---|
| base | strategy | 0 |
| day | strategy + day condition | 1 |
| tranche | strategy + tranche | 2 |
| tranche and day | strategy + tranche + day condition | 3 |

Resolution takes every row whose scope matches the situation, orders them by
priority descending, and takes **the first non-null value for each column
independently**. A base row supplying the stop-loss percentage and a tranche
row supplying only the strike type merge into one configuration; the tranche
row does not have to repeat the stop.

This is why almost every column in that table is nullable. A null means "not
set at this scope", never "set to nothing" — and that distinction is the whole
mechanism. Anything that reads the table by taking the highest-priority *row*
rather than merging columns will silently lose most of a strategy's settings.

The reference engine has two further scopes, per user and per broker, and
weights its priority arithmetic to leave room for them. Garuda dropped both
deliberately (recorded on `StrategyConfigRow`): one operator, and a strategy
that behaves differently on one account than another cannot be reasoned about.

## 2. Build order

Each step ends with something that runs and tests that prove it.

1. **Day conditions.** A pure function from a trading day and the expiry
   calendar to the conditions that hold — `E`, `DT1`. Needed by everything
   below it, and testable with nothing but a calendar.
2. **Config resolution.** Rows to one resolved configuration, merging per
   column by priority. Pure, and the place where a subtle bug is most
   expensive: a lost stop-loss percentage is a position with no stop.
3. **Protection from configuration.** Resolved stop and target percentages to
   a `Protection`, given an entry price. This closes the largest gap left by
   the signal seam — today every signal enters at market with no stop.
4. **Strike selection.** `MoneyNess` first, since it is most of the book:
   ATM and n-strikes either side, resolved against the option chain. Then the
   premium-based rules. `CandleLow_NearPremium` needs candles and waits.
5. **Strategy definitions to specs.** A definition plus its resolved
   configuration becomes a `StrategySpec`: the legs, their sides, the hedge
   offset, the product.
6. **Subscriptions.** Which trading client runs which strategy, with what
   capital, paper or live. This is where an account and a strategy meet.
7. **The scheduler.** Tranche times to evaluations: at a configured time, for
   each active subscription, evaluate and hand the intents to the signal
   factory. This is the step where the engine first produces a trade.
8. **Direction providers.** Fixed first, then candle-based. The indicator,
   IV-skew and PCR providers need machinery that does not exist yet.

Steps 1–3 are pure and can be built and tested with no database and no feed.
Step 7 is where the engine stops being a thing that starts and becomes a thing
that trades.

## 3. Decided

- **Unknown vocabulary is refused, not guessed.** A `strike_type` this engine
  does not implement raises rather than falling back to ATM. A strategy that
  silently trades a different strike than configured is worse than one that
  does not trade.
- **The scheduler drives entries.** Ticks drive the entry service, the tracker
  and trailing — not the decision to trade.
- **Null means "not set at this scope".** Never "set to nothing".

## 5. Where capital comes from

Settled. Three tables can supply a number and only one of them is read at
trading time.

**`subscriptions.capital` is the answer.** A subscription is one trading
client running one strategy, and its capital column is what the sizer uses.
Nothing else is consulted while trading.

The other two are how that number gets *set*, which is a different activity
happening at a different time:

- **An allocation model is a plan, not a runtime input.** It names a total
  capital, splits it intraday versus positional, and lists how many lots of
  each strategy it wants. Choosing a model for a trading client is what
  derives each subscription's capital; after that the model has done its job.
- **Capital per lot** lives on the strategy definition, because how much
  capital one lot of a strategy needs is a property of the strategy, not of
  whoever runs it. It is the bridge: a model asking for four lots of a
  strategy whose capital per lot is one figure produces a subscription capital
  of four times it.

So the chain is `model → lots × capital-per-lot → subscription capital →
sizer`, and only the last arrow happens while the market is open.

**Overlap.** Both the model's strategy map and the strategy definition carry an
overlap flag, and roughly a fifth of configured strategies set it. It exists
because strategies that cannot be open at once do not each need their own
capital reserved. The exact arithmetic — whether overlapping strategies sum,
or take the largest, or something between — is not settled and matters only
when a model is being *applied*, not when a trade is being sized.

**Equity sizes differently.** Options size from capital per lot; equity sizes
from a fixed amount per stock with a cap on how many positions may be open at
once. That is the only equity sizing model in use, and it is a different
formula rather than a variation of the same one.

**Risk-based sizing is also real.** A meaningful minority of strategies set a
risk percentage, sizing so that being stopped out costs a fixed fraction of
capital. `RiskAwareLotAllocator` already implements it; what is missing is
reading the configured percentage.

**Two columns are dead.** Leverage and maximum-risk-per-trade are set on no
configured strategy at all. They are not ported.

## 6. Open

- ~~A hedge that sizes to zero~~ **Settled: refuse the whole entry.** A short
  option whose hedge was dropped for want of a lot is a different position
  from the one that was designed, not a smaller one. Already what
  `engine/signals.py` does.
- **Reading the capital.** The chain is settled (§5); nothing reads
  `subscriptions.capital` yet, and `SignalFactory.build` still takes capital
  as an argument.
- ~~`lot_allocation_mode`~~ **Settled: only the daily mode.** `GLOBAL_SHARED`
  spread a lot budget across tranches and is deliberately dropped — see
  `SCOPE_DECISIONS.md`. A lot budget is per day, and `global_allocation_tranches`
  and `allocation_start_tranch` go with it.
