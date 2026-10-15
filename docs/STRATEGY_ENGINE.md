# Strategy engine — design and build order

Decided with the owner on 2026-10-15. This replaces the rules proposal
(`STRATEGY_RULES.md`, deleted) and the earlier "spec and one evaluator"
design in `DESIGN.md` §10, which this document now defines. Read
`SCOPE_DECISIONS.md` §5 for what is in and out.

## 0. The decision in one paragraph

The reference engine's strategy layer is ported **feature for feature**: its
definition and configuration vocabulary, its scheduled tranches, its strike
selection, direction providers, lot allocation, breakout watches, adaptive
tranches, re-entry, hedge windows and persisted state. What is *not* ported
is its seven-class evaluator hierarchy keyed by a template table. In its
place: **one pipeline with a hook per step, four registries of pluggable
parts, and definition fields for the behaviours a template used to encode.**
A developer who needs logic the configuration cannot express subclasses the
base strategy and overrides a hook; everything else keeps running around it.

The earlier deviation — rules as triggers, legs as the primary shape, a
one-second sweep, no templates *and* no template behaviours — is withdrawn.
What it got right (per-column config resolution, day conditions, indicators,
the rule translator, protection parsing, trade management) stays.

## 1. Vocabulary

The reference's, exactly. These are the values the engine accepts; anything
else is refused by name at save time, never guessed at.

| Field | Values |
|---|---|
| `trade_mode` | `OPTION_SELLING` · `OPTION_BUYING` · `FUTURES` · `FUTURES_OPTIONS` · `EQUITY` |
| `product` | `INTRADAY` · `POSITIONAL` · `CASHBUY` · `MTF` |
| `underlying_type` | `INDEX` · `FUTURE` · `SYNTHETIC_FUTURE` |
| `expiry_type` | `WEEKLY` · `MONTHLY` |
| `direction_provider_type` | `FIXED` · `CANDLE` · `INDICATOR` · `PCR` · `IV_SKEW` · `N_BARS_BREAKOUT` · `ORB_BREAKOUT` · any registered name |
| `strike_type` | `MoneyNess` · `FixedPremium` · `PremiumRange` · `PremiumRange_OIRanked` · `CandleLow_NearPremium` · `FixedDelta` |
| `strike_value` (MoneyNess) | `ATM` · `ITM-1`…`ITM-5` · `OTM+1`…`OTM+5` |
| `day_condition` | `E` · `DT1` · `DT2` · `M` · `T` · `W` · `TH` · `F` |
| `risk_calculation_mode` | `STOP_LOSS` · `WING_WIDTH_MAX_LOSS` |
| `trail_sl_type` | `RISK_MULTIPLE` · `PERCENTAGE` · `ATR` · `EMA` · `SUPERTREND` · `HEIKIN_ASHI` |
| `exit_mode` | `SAME_DAY` · `MINUTES_FROM_ENTRY` · `DAYS_FROM_ENTRY` · `DTE` · `EXPIRY` |
| `lot_allocation_mode` | `DAY_LOCAL` only (`GLOBAL_SHARED` is out, §5) |
| `breakout_watch_type` | `OPTION_SYMBOL` · `UNDERLYING` |
| `breakout_trigger_mode` | `PERCENTAGE` · `ABSOLUTE` · `CANDLE_LOW` · `RANGE` |
| `breakout_direction` | `ABOVE` · `BELOW` · `EITHER` |
| `breakout_range_type` | `INTRADAY_WINDOW` · `PREVIOUS_DAYS` |
| `breakout_reversal_mode` | `NONE` · `AFTER_CLOSE` · `PARALLEL` |
| `equity_sizing_model` | `FIXED_AMOUNT_PER_STOCK` · `MAX_POSITIONS_EQUAL_SPLIT` · `MAX_RISK_PER_TRADE` |
| `status` | `ACTIVE` · `WIND_DOWN` · `INACTIVE` |

Triggers are four booleans on the definition, as in the reference:
`scheduled_trigger_enabled`, `tick_trigger_enabled`, `periodic_trigger_enabled`,
`signal_trigger_enabled`. The last is stored and refused when set, until
external signals are built (§9).

## 2. Data model

The reference's tables, already ported, with these changes:

- **`strategy_templates` is dropped**, and `strategy_definitions.template_name`
  with it. There is no template. The reference's template `DEFAULT_CONFIG` is
  replaced by a seeded base row in `strategy_config` for each new strategy.
- **`strategy_definitions` gains** `strategy_class` (null = the base pipeline;
  otherwise a registered custom strategy, §7) and `use_indicator_entry`, and
  does not gain `template_params` (only the two unported templates used it).
- **`strategy_config` gains** the columns garuda's port missed: `target_delta`,
  `breakout_range_type`, `breakout_range_start`, `breakout_range_end`,
  `breakout_range_lookback`, `breakout_on_high_break`, `breakout_on_low_break`,
  `breakout_reversal_mode`; and two new ones from the 0DTE template,
  `stop_after_loss_tranches` and `stop_after_profit_tranches`.
- **`strategy_days_allocation`** (new, from `STRATEGY_DAYS_ALLOCATION_CONFIG`):
  per strategy, the percentage of lots on each weekday and on `E`, `DT1`,
  `DT2`. Keyed by strategy alone, since allocation models are out.
- `strategy_indicator_rules` keeps the reference's JSON shape (`operator` /
  `condition` trees) as the only shape.
- `subscription_state` is the reference's `USER_STRATEGY_STATE`: one row per
  subscription per trading day, `state_data` holding the strategy state (§6).
- `strategy_breakout_watches`, `strategy_evaluation_log`, `hedge_schedules`,
  `strategy_symbol_subscriptions` are read and written as the reference does.
  `strategy_symbol_subscriptions` is kept only for the Console's chain
  subscriptions, as the reference keeps it.

### Configuration resolution

Unchanged from what is built: rows at base, day, tranche, and tranche-plus-day
scope; **merged per column**, the most specific non-null value winning. The
user and broker scopes are out (`SCOPE_DECISIONS.md` §5).

The runtime configuration for one subscription on one day is built in the
reference's order, and every evaluation sees exactly this object:

1. engine defaults;
2. the definition's columns;
3. the subscription: capital, `is_paper_trading`, and `risk_percentage`,
   `absolute_max_risk`, `leverage`, `max_active_positions` **clamped** to the
   definition's min and max, as the reference clamps them;
4. the config tree for the day condition, per column;
5. one `TrancheConfig` per tranche number found in any applicable row, each
   resolved per column for that tranche and day, with the base-and-day rows
   as the default tranche config.

`strategy_event_days` scales lots on a dated event day, as built.

## 3. The runtime

```
event sources ──► per-subscription queue ──► one task per subscription
  SCHEDULED        (serialised)               │
  TICK                                        ▼
  PERIODIC                              Strategy.handle(event)
  TRANCH_COMPLETE                             │
  BREAKOUT                                    ▼
  HEDGE_WINDOW                 signals ──► SignalProcessor ──► trade management
  (EXTERNAL_SIGNAL: enum only)  exits   ──► square-off
```

- **One asyncio task per active subscription** consumes that subscription's
  queue. This is the reference's per-subscription serialisation without its
  striped locks: two events for the same subscription never overlap, two
  subscriptions never wait on each other.
- **Event sources** are Clock-driven tasks, one per kind. Each knows which
  subscriptions it addresses:
  - `SCHEDULED` — the tranche scheduler (§4) fires at each consolidated
    tranche time for the subscriptions sharing it.
  - `TICK` — the feed, to subscriptions whose underlying matches, **only when
    the subscription has active trades or live breakout watches**, as in the
    reference.
  - `PERIODIC` — a minute timer, to subscriptions whose
    `periodic_interval_minutes` divides the minute, delayed by
    `periodic_offset_seconds`, inside the start–stop window.
  - `TRANCH_COMPLETE` — trade management, when the last trade of a tranche
    group exits, carrying the tranche's P&L and exit reason.
  - `BREAKOUT` — the breakout watch service, on a tick that breaches a watch.
  - `HEDGE_WINDOW` — the hedge window scheduler, at the start of a morning or
    evening window and on each recovery check.
- **Loading and reload.** At start of day per venue, and on every write to a
  definition, config row or subscription: active subscriptions × active
  definitions become registrations; the tranche schedules are rebuilt; state
  is restored. Reload is incremental in effect — a subscription deactivated
  mid-day stops receiving events at the next one; a config change re-resolves
  at the next evaluation. **No restart for any of it.**
- **End of day** flushes state and clears the day's in-memory marks, as the
  reference's end-of-day task does.

## 4. The pipeline

`BaseStrategy` is the reference's F&O evaluator as **one fixed sequence of
hooks**. The default implementation of every hook is "what the configuration
says". The order is the reference's and is not configurable.

**On `SCHEDULED` (and on `BREAKOUT`, entering at step 3):**

1. **`gate`** — status `ACTIVE`; not a holiday; `exclude_monthly_expiry`;
   `excluded_days` then `tradable_days`; inside `start_time` to the tranche
   cutoff (or `stop_time`); the tranche not yet signalled today; and, when
   `use_indicator_entry`, the entry rule tree passes.
2. **Breakout gate** — if this tranche has `breakout_enabled`, create the
   watches now and stop: an `OPTION_SYMBOL` watch selects strikes immediately
   and waits for the premium to breach; an `UNDERLYING` watch builds the range
   band (`INTRADAY_WINDOW` or `PREVIOUS_DAYS`) and waits for the spot. A range
   whose window has not elapsed yields "not ready" and is retried on the next
   event. Only "disabled" falls through to an immediate entry; a failed watch
   is a critical alert and no entry.
3. **`direction`** — the breakout's breached side if entering from a watch;
   otherwise the providers in the definition's order, first opinion wins;
   then the applicable-direction filter. A non-directional strategy answers
   `BOTH`. A provider answers `LONG`, `SHORT`, `BOTH` or declines.
4. **`legs`** — the shape from `trade_mode`, the direction and
   `combo_spec_json`: an option pair (CE and PE, each with its hedge), a single
   option leg (`OPTION_SELLING` sells the PE on `LONG`; `OPTION_BUYING` buys the
   CE), a future, combo legs resolved one by one, or one entry per universe
   member for equity. Each option leg goes through its **strike selector**
   (`strike_type`), the **premium-balanced straddle selector** when
   `use_premium_balancing`, the **hedge offset** resolver (distance %, rounded
   to the strike gap and then to the symbol's rounding multiple past the
   minimum distance), the **liquidity filters** (volume and OI; hedges exempt
   unless flagged), and the wing-width capture for `WING_WIDTH_MAX_LOSS`. Any
   leg that cannot be resolved stands the whole entry down.
5. **`lots`** — `capital ÷ capital_per_lot` (hedged or naked by
   `hedging_enabled`) × the day-allocation % × the event-day %, through the
   sequential allocator across the day's tranches and, when a risk percentage
   is set, the risk-aware allocator. Equity uses the sizing model instead.
   Zero lots refuses the entry whole, with an alert.
6. **`emit`** — freeze-quantity slicing; the reference's group id
   (`[date|]Tranch-n|Slice-s`), pair correlation ids, hedge correlation and
   combo ids; `exit_trade_at` from `exit_mode`; protection from the tranche
   config; the signals go to the signal processor. The tranche is marked
   signalled and the state persisted.

**On `TICK`:** combined stop, combined target and combined trail per group,
throttled as the reference throttles them; tick-driven trailing is trade
management's. **On `PERIODIC`:** with active trades, the exit rule tree when
`use_indicator_exit`; otherwise the entry path for the next tranche. **On
`TRANCH_COMPLETE`:** when `adaptive_tranches_enabled`, the next tranche fires
unless the exit reason is one that suppresses the cascade, `max_tranches` is
reached, `stop_after_loss_tranches` or `stop_after_profit_tranches` is hit,
or the window has closed. **After a stop-loss exit** the reference's re-entry
watch is created when `re_entry` is on: an option-symbol watch below the
original entry, up to `max_reentries`, only past `min_reentry_loss_percentage`.
**On
`HEDGE_WINDOW`:** replace each short's hedge at the window's distance, with
the reference's status machine and recovery limits.

Every hook is a method with a default. Overriding one does not change the
order, the state handling, the fail-closed behaviour or anything downstream.

## 5. What a template used to be

| Reference template | Here |
|---|---|
| `ADVANCED_OPTIONS` | the pipeline with its defaults |
| `ZERODT_OPTIONS` | `adaptive_tranches_enabled` + `stop_after_loss_tranches` + `stop_after_profit_tranches` |
| `INDICATOR_ADVANCED_OPTIONS` | `use_indicator_entry` and `use_indicator_exit`, on any strategy |
| `SIXTH_SENSE_OPTIONS` | **not ported now.** Its five-day-move signal is a candidate for the sample custom strategy planned after the base lands |
| `ADAPTIVE_OPTIONS` | **not ported now.** Its always-in-position and re-entry-on-flip logic is the other candidate for that sample |
| `COMBO_STRATEGY` | `combo_spec_json` |
| `EQUITY` | `trade_mode = EQUITY` with a universe and a sizing model |

The capability flags, the template resolver and the Console's template-name
checks go. The form shows sections by `trade_mode` and the flags.

**Deliberately out**, each recorded in `SCOPE_DECISIONS.md`: `GLOBAL_SHARED`
lot allocation; the user and broker config scopes; mock sessions; the
template table. **External signals are deferred, not out** (§9).

## 6. State

The reference's `StrategyState`, one row per subscription per trading day in
`subscription_state`: last tranche signalled, tranche signal times, signals
generated today, used risk, lots allocated today, evaluation and signal
counts, and a `data` map namespaced per provider or custom strategy.

- Written at most every thirty seconds, and **at once** when a critical field
  changes (a tranche signalled, risk used), exactly the reference's rule.
- Restored at start of day: signalled tranches, so a restart never fires a
  tranche twice.
- Carried across days only for positional strategies by expiry cycle, which
  is what the reference's cross-day state does and the only case it has.

The in-memory tranche ledger built earlier is folded into this; a ledger that
forgets at restart was the defect the reference's state row exists to avoid.

## 7. Custom strategies

Garuda is open source, and the configuration will not express everything.
A developer writes a subclass of `BaseStrategy`, overrides the hooks they
need, and leaves the rest to the configuration:

```python
from garuda.engine import BaseStrategy, strategy

@strategy("MY_EXPIRY_SCALPER")
class MyExpiryScalper(BaseStrategy):
    params = MyParams            # a dataclass; the Console renders its fields

    async def direction(self, ctx):          # one hook overridden
        ...
```

- **Discovery:** an installed package exposing a `garuda.strategies` entry
  point, or a module dropped into `<app home>/plugins/`. Both register by
  name at startup. A definition names one in `strategy_class`; null is the
  base. An unknown name is refused at save.
- **The same registries** take custom direction providers, strike selectors,
  indicators and rule conditions with a decorator, so adding a provider does
  not require a strategy.
- **Fail closed applies.** A hook that raises, or returns a malformed value
  (a float in a money field, an unlisted instrument), stands the entry down
  and raises a critical alert. The Clock and `Decimal` rules are documented
  for authors and enforced where the engine can see the result.
- **Nothing in core subclasses the base.** The two reference templates that
  would have (§5) are not ported now; a sample custom strategy is planned
  once the base implementation is complete, and it will be the first user of
  the hooks. Until then the hooks are tested with a test-only subclass.

## 8. Console

The Strategy Engine page has three tabs. **Definitions** edits a strategy in
the reference form's sections -- basic information and a custom class, what
it trades (trade mode, underlying, product, expiry, the price strikes come
off, combo legs through the reference's combo editor), direction and leg
order, triggers, timing and day lists, capital and hedge (with the hedge
replace windows), risk, equity sizing, lifecycle -- with a Rules dialog for
the entry, direction and exit trees and a Days dialog for day allocation.
**Subscriptions** puts a strategy on a trading client. **Engine Monitor**
shows today as the running engine sees it: the tranche schedule, armed and
finished breakout watches, and each account's strategy state. Per-tranche
settings stay on the Strategy Config page.

*Decided while building, 2026-10-15:* the reference's own definition page was
not routed. Its template derivation runs through fifty-odd checks of a
template name across six thousand lines; with no templates, adapting it would
have been rewriting it. The routed page was brought to the reference form's
fields instead, reusing its combo editor and rule builder. The reference's
copied pages remain in the tree, unrouted, for reference.

## 9. Deferred

- **External signals.** The reference received them as "signal" frames from
  its data feed. Garuda's market data is in-process, so the source will be an
  API endpoint and in-process conditions, with the reference's `ENTRY` and
  `EXIT` semantics and tranche selection. The `EXTERNAL_SIGNAL` event type and
  dispatcher branch exist from the start so that adding the producer is the
  whole job. Tracked in `TODO.md`.

## 10. Build order

Each step ends with a running engine and behavioural tests.

1. **Schema and runtime config.** The migrations above; templates removed;
   the runtime config built in the reference's order; the base-row seed on
   strategy creation.
2. **Scheduler, state, dispatcher, first trade.** Consolidated tranche
   schedules; the scheduler with cutoff, gap, catch-up and day checks; state
   persisted and restored; the per-subscription task; the pipeline for an
   at-the-money option pair with hedges and the lot allocator.
3. **Selection and direction.** The remaining strike selectors, the straddle
   selector, the seven providers, the single-leg, futures and combo shapes.
4. **Tick and breakout.** Combined stop, target and trail; the breakout watch
   service with option-symbol and underlying watches, ranges and reversal.
5. **Periodic and adaptive.** Indicator entry and exit; adaptive tranches;
   stop rules; re-entry watches after a stop; the custom-strategy registry,
   proven with a test-only subclass.
6. **Hedge windows, equity, log.** Replace and recovery; equity with
   universes and the three sizing models; the evaluation log.
7. **Console.**
