# Rules — proposal

A strategy decides three things: **whether** to enter, **which way**, and
**when to get out**. This proposes that all three be expressed as lists of
small, independently testable, pluggable rules — and that the engine own no
knowledge of what any particular rule means.

Status: proposal. Nothing here is built. It supersedes the trigger-type
framing in `STRATEGY_ENGINE.md` §1 and extends `DESIGN.md` §10.2.

## 1. What disappears

The reference engine has four trigger types on a strategy — tick, scheduled,
signal, periodic — as separate boolean columns with separate dispatch paths.
It also has a `direction_provider_type` naming one of six providers, and a
dedicated table *and* service for exactly one kind of condition (breakout
watches), which carries its own `is_triggered` / `valid_till` / `is_expired`
lifecycle and a copy of the resolved trade.

All of it says the same thing in five different vocabularies: *a condition
that must hold before a position goes on.*

Under this proposal:

| Today | Becomes |
|---|---|
| `scheduled_trigger` + tranche time | an `at_or_after` rule |
| `tick_trigger` | nothing — every rule set is live |
| `periodic_trigger` | an `every` rule |
| `signal_trigger` | an `external_signal` rule |
| breakout watch table + service | a `breakout` rule, on the ordinary lifecycle |
| `direction_provider_type` | an ordered list of direction rules |
| `use_indicator_exit` | an exit rule list that happens to contain indicators |

`DESIGN.md` §10.2 already argued that a template must not be a class, because
single inheritance can express only one axis of variation. A trigger *type* is
the same mistake one level down: it spends a whole dimension on "what wakes
this up", when what an operator actually wants is "enter at 13:00 **and** only
if VIX is under 14 **and** only if the 5-minute ATR is contracting".

The reference engine cannot express that sentence. This design is that
sentence.

## 2. One concept

```python
class Rule(Protocol):
    def evaluate(self, context: RuleContext) -> RuleOutcome: ...
```

That is the whole interface. A rule is a **pure predicate over a context**: it
reads, it decides, it explains. It does not place orders, log, sleep, hold a
clock, or reach for a database.

Purity buys three things that matter here: a rule is testable with a
dictionary, a recorded day replays identically, and the engine may reorder
evaluation by cost without changing the answer.

## 3. Outcomes are three-valued, and missing data is not "false"

```python
class Verdict(StrEnum):
    PASS = "PASS"           # the condition holds
    FAIL = "FAIL"           # it does not
    UNAVAILABLE = "UNAVAILABLE"   # cannot tell — no quote, no candles, no VIX

@dataclass(frozen=True)
class RuleOutcome:
    verdict: Verdict
    because: str            # one sentence, for the operator
    detail: Mapping[str, object] = ...   # the numbers it compared
```

`UNAVAILABLE` blocks entry exactly as `FAIL` does — **fail closed** — but it
means something different and must be reported differently. A rule that fails
all day is a strategy waiting for its condition. A rule that is *unavailable*
all day is a broken data path wearing the costume of a strategy that never
triggered, and it should raise an alert, not sit quietly.

Collapsing the two is how a feed outage becomes "the strategy just didn't get
a signal today".

## 4. Composition is not special

`all`, `any` and `not` are rules. They take other rules as parameters.

```json
{"type": "all", "rules": [
  {"type": "at_or_after", "time": "13:00"},
  {"type": "any", "rules": [
    {"type": "vix_below", "value": 14},
    {"type": "indicator", "indicator": "ATR", "interval": "5m",
     "params": {"period": 20}, "comparator": "lt",
     "reference": {"indicator": "ATR", "params": {"period": 100}}}
  ]}
]}
```

So there is one concept, not two, and arbitrary boolean logic costs no engine
code. A strategy's `entry_rules` is simply a rule — conventionally an `all`.

`any` short-circuits on the first `PASS`; `all` on the first `FAIL`. An
`UNAVAILABLE` inside an `any` is not fatal if a sibling passes — which is
right: "VIX below 14 **or** ATR contracting" should still work when the VIX
feed is down, provided ATR answers.

The reference already stores rule trees as JSON with `operator`/`condition`
nodes. The shape above is a mechanical translation of that, so the Console's
existing rule builder survives with a thin adapter.

## 5. Three rule sets, two shapes

| Set | Shape | Asked | Evaluated against |
|---|---|---|---|
| `entry_rules` | predicate | may this tranche go on? | the subscription and tranche |
| `direction_rules` | resolver | long or short? | the same |
| `exit_rules` | predicate | should this position come out? | one open trade |

Direction is the odd one: it answers `Direction | None`, not pass/fail. So it
is a second small protocol sharing the same registry, context and plug-in
mechanism:

```python
class DirectionRule(Protocol):
    def resolve(self, context: RuleContext) -> Direction | None: ...
```

`direction_rules` is an ordered list and **the first rule that answers wins**;
none answering means the strategy stands aside. That subsumes all six of the
reference's direction providers, and lets them be chained — "use the IV skew,
and if it is flat fall back to the candle" — which today needs code.

Exit rules see everything entry rules see **plus the trade**: its entry price,
its age, its unrealised P&L, its group. That is what "the rolling straddle is
10% below where we entered" needs.

**Exit rules do not replace stops.** The stop-loss, the target and the
square-off deadline live in trade management and are placed as real orders at
the broker. Exit rules are the discretionary layer above them: conditions that
should take a position off early. A rule set that never fires must never be
the reason a position had no stop.

## 6. Rules arm; the trigger price fires

The obvious worry with "everything is continuously evaluated" is latency:
a breakout wants to be acted on in milliseconds, and re-running a rule tree
per tick across every strategy will not do that.

It does not have to. There are already two stages, and the fast one is built:

1. **Rules arm.** When a tranche's entry rules all pass, the strategy resolves
   its legs and emits signals — carrying a **trigger price**.
2. **The entry service fires.** It is already watching ticks, and places the
   order the moment the trigger is crossed.

So rule evaluation runs at a modest cadence — a second, configurable — and
the tick-speed reaction comes from the machinery that already reacts at tick
speed. A breakout rule does not need to see every tick; it needs to decide
*that we are watching for a break at level X*, and hand X to the thing whose
job is watching.

This is also, exactly, what the reference's breakout-watch table does: arm a
watch carrying the resolved instrument, quantity and entry premium, then fire
on price. The proposal keeps the behaviour and deletes the bespoke table, the
bespoke service and the second lifecycle.

Rules that genuinely need faster evaluation can declare it; the default should
not be to evaluate everything on every tick.

## 7. Once-ness belongs to the tranche, not the rule

A continuously-evaluated rule set that passes at 13:00:01 also passes at
13:00:02. Something must make an entry happen once.

That something is the **tranche**, and it gets an explicit lifecycle:

```
WAITING ──rules pass──▶ ARMED ──signals delivered──▶ FIRED
   │                        │
   └──── cutoff passed ─────┴──▶ EXPIRED
```

- The evaluation unit is `(subscription, tranche, trading day)`.
- A tranche that has FIRED is not evaluated again.
- A tranche past its cutoff EXPIRES and stops being evaluated, with a note
  saying which rule was still blocking it. That note is the answer to "why
  didn't tranche 3 go on today", which is otherwise unanswerable.
- `max_tranches`, `min_tranch_gap` and `tranch_cutoff_time` already exist as
  configuration and become properties of this lifecycle rather than of a
  scheduler.

The lifecycle is persisted, so a restart at 13:05 does not re-enter a tranche
that fired at 13:00. Duplicate detection in trade management is the backstop,
not the mechanism — a position must not depend on dedup to avoid being taken
twice.

## 8. What a rule can see

`RuleContext` is the whole surface a rule gets, and getting it right matters
more than any individual rule, because every future rule is limited by it.

```python
class RuleContext(Protocol):
    now: datetime
    trading_day: date
    strategy: str
    trading_client: TradingClientId
    tranche: int
    config: ResolvedConfig
    underlying: InstrumentId
    trade: Trade | None            # exit rules only

    def quote(self, instrument) -> Tick | None
    def candles(self, instrument, interval, count) -> Sequence[Candle]
    def indicator(self, name, instrument, interval, **params) -> Decimal | None
    def chain(self, underlying, expiry) -> OptionChain | None
    def derived(self, kind, underlying) -> Decimal | None   # VIX, PCR, IV, straddle
    def positions(self) -> Sequence[Trade]
    def memory(self) -> MutableMapping[str, object]   # opt-in, persisted
```

Three properties it must have:

- **Lazy.** A rule that never runs because an earlier one failed must cost
  nothing. Candles are not fetched until asked for.
- **Cached per evaluation.** Two rules asking for `EMA(9, 5m)` in one pass
  compute it once. Without this, a ten-rule tree is ten redundant indicator
  computations a second.
- **Consistent within an evaluation.** Every rule in one pass sees the same
  `now` and the same prices. A tree where rule 1 saw 100 and rule 5 saw 101 is
  a tree that can contradict itself.

Everything returns `None` rather than raising when data is absent, and the
rule turns that into `UNAVAILABLE` with a sentence naming what was missing.

## 9. Most rules must not remember anything

State across evaluations is where replay and restart break. The default is
that a rule derives everything from history: "three consecutive green
candles" reads three candles, it does not count them as they happen.

`memory()` exists for the few that genuinely cannot — "the first breakout of
the day", "we already retested" — and is opt-in, keyed by
`(subscription, tranche, rule)`, and persisted with the strategy's state so a
restart does not lose it. A rule using memory should say so in its
registration, because it is the thing that makes a replay diverge.

## 10. Plugging in a new rule

Registration by name, not by inheritance:

```python
@rule("vix_below")
@dataclass(frozen=True)
class VixBelow:
    value: Decimal

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        vix = context.derived("VIX", context.underlying)
        if vix is None:
            return unavailable("VIX is not being published")
        return passed(f"VIX {vix} is below {self.value}") if vix < self.value \
            else failed(f"VIX {vix} is not below {self.value}")
```

- The decorator registers a **name** and a schema derived from the dataclass
  fields. Configuration stores `{"type": "vix_below", "value": 14}`.
- Out-of-tree rules register through a `garuda.rules` entry point, the same
  mechanism `DESIGN.md` already reserves for third-party evaluators. Installing
  a package makes its rules configurable; nothing in core changes.
- **An unknown rule type is refused at save time and at load time**, never
  ignored. A rule silently dropped turns "enter only if VIX is low" into
  "enter", which is the most expensive possible failure mode for this feature.
- Parameters are validated against the schema when the strategy is saved, so a
  typo is a form error rather than a 13:00 surprise.

A rule declares two hints, neither affecting its result:

- **cost** — `free` / `cheap` / `expensive`. The engine evaluates cheap rules
  first within an `all`, which is sound precisely because rules are pure. A
  time check runs before an option-chain scan without anyone ordering them.
- **dependencies** — which instruments and intervals it reads. This is what
  lets the engine skip evaluating a strategy nothing relevant has changed for,
  if the flat cadence ever becomes too slow. Optional; an undeclared
  dependency costs performance, never correctness.

## 11. Safety

A third-party rule is untrusted code inside the trading loop.

- An exception becomes `UNAVAILABLE` plus an alert, never a crash, and never a
  `PASS`.
- A rule that raises repeatedly is disabled for the day with a CRITICAL alert
  naming it. A strategy whose rule is disabled does not trade: a rule set with
  a hole in it is not a weaker rule set, it is a different one.
- Evaluation is time-boxed. A rule that overruns is `UNAVAILABLE`.
- Every evaluation records the verdict of the rule that stopped it, and every
  *transition* is journalled. Not every tick — the blocking rule changing is
  the event worth keeping.

## 12. A catalogue

What the engine could ship. None of it is engine code — each is a small class
with a name, and the list is meant to grow.

**Time and session**
`at_or_after` · `before` · `within_window` · `minutes_after_open` ·
`minutes_before_close` · `every` (periodic) · `on_day_condition` (expiry, DT1,
weekday) · `days_to_expiry_between` · `min_gap_since_previous_tranche` ·
`not_in_first_n_minutes`

**Price and level**
`price_above` / `price_below` (absolute, or relative to open / previous close /
day high / day low / VWAP) · `percent_from_reference` ·
`breakout` / `breakdown` of a level with a confirmation mode (touch, close,
N consecutive closes, percentage buffer) · `opening_range_break(minutes)` ·
`gap_up` / `gap_down` · `previous_day_high_break` · `pivot_cross`
(classic, Camarilla, Woodie) · `round_number_proximity`

**Candle shape and statistics** — the family asked about
`narrow_range(n)` (NR4, NR7, NR21: today's range the narrowest of the last n) ·
`wide_range(n)` · `inside_bar` · `outside_bar` · `consecutive(n, direction)` ·
`higher_highs(n)` / `lower_lows(n)` · `range_contraction` / `range_expansion` ·
`doji` · `hammer` / `shooting_star` · `engulfing` · `harami` · `marubozu` ·
`morning_star` / `evening_star` · `three_soldiers` / `three_crows` ·
`body_percent_of_range` · `close_in_top_third` / `close_in_bottom_third`

**Indicators** — one generic rule, not one per indicator
`indicator(name, interval, params, comparator, value | reference_indicator)`
covers RSI > 60, EMA(9) above EMA(21), close above VWAP, MACD histogram
positive, ADX above 25, ATR(20) below ATR(100), and everything else of that
shape. Adding an indicator adds no rule. Alongside it, the few that are not
comparisons: `supertrend_direction` · `bollinger_squeeze` ·
`bollinger_break` · `heikin_ashi_colour` · `renko_direction` ·
`choppiness_below` (a trend-versus-range filter)

**Volatility and option structure**
`vix_above` / `vix_below` / `vix_change_percent` · `iv_above` / `iv_below`
(ATM or a named strike) · `iv_percentile(lookback)` · `iv_rank` ·
`iv_skew` (call minus put) · `pcr_above` / `pcr_below` (OI or volume) ·
`max_pain_distance` · `straddle_price_change_percent` — the rolling-straddle
rule · `synthetic_future_basis` · `option_premium_between` ·
`theta_decay_rate`

**Liquidity and microstructure**
`min_volume` · `min_open_interest` · `oi_change_percent` ·
`max_spread_percent` · `min_depth_quantity(levels)` · `not_near_circuit`

**Position and portfolio state** — mostly, but not only, exits
`no_existing_position_in` · `max_open_positions` · `max_trades_today` ·
`daily_loss_below` · `daily_profit_below` (stop after the day's target) ·
`unrealised_pnl_percent` · `time_since_entry` · `breakeven_reached` ·
`hedge_present` (refuse a naked short if its hedge is gone)

**External and calendar**
`external_signal(name)` · `event_day` / `not_event_day` · `news_blackout` ·
`market_regime` (a named classification, once something publishes one)

**Composition**
`all` · `any` · `not` · `at_least(n, rules)` · `ref(name)` — a named,
reusable rule set, so common filters are written once and referenced from many
strategies rather than copied into each.

## 13. Configuration

Rules are list-valued, and the per-field merge in `engine/config.py` handles a
list badly: half-overriding a list is a footgun with no good semantics. So:

- `entry_rules`, `direction_rules` and `exit_rules` are **single JSON fields**
  on the configuration. A narrower scope replaces the whole list, it does not
  merge into it. Predictable, and easy to explain.
- Reuse comes from `ref` and named rule sets, not from list merging. A tranche
  that wants the base filters plus one more writes
  `{"type": "all", "rules": [{"type": "ref", "name": "morning-filters"}, ...]}`.

## 14. What this asks the owner to decide

1. **Exit rules: all, or any?** The description says all must pass, same as
   entry. For entry that is clearly right. For exits, "get out if *any* of
   these fires" is the more usual reading, and an `all` exit that needs four
   conditions at once may never fire. Both are expressible — the question is
   which the default should be. My inclination: default `any` for exits,
   because the failure mode of the wrong default is a position that will not
   come out.
2. **Should direction rules be able to veto?** First-answer-wins means a
   direction rule cannot say "do not trade at all today", only "I have no
   opinion". A separate entry rule can veto. Keeping them separate seems
   cleaner, but the reference lets a direction provider stand a strategy down.
3. **Cadence.** One second for rule evaluation, with tick-speed left to the
   trigger price. Faster costs CPU across every strategy; slower delays arming.
4. **Where the catalogue starts.** The whole list above is not a first
   deliverable. A first cut of `all`/`any`/`not`, `at_or_after`, `before`,
   `indicator`, `breakout` and `vix_below` would carry the shapes already
   configured today, and everything else is additive by construction.
