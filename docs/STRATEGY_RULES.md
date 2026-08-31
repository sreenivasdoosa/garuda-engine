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
The "signal" one is not what its name suggests, and §6 deals with it
separately: nothing external is involved.
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
| `signal_trigger` | nothing — see §6 |
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
    {"type": "price_below", "instrument": "SYNTH:VIX", "value": 14},
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

A position therefore leaves when **the stop fires, or the target fires, or the
square-off time arrives, or every exit rule passes** — the hard exits in
parallel with the rule set, not downstream of it. That is what makes `all` the
right combinator inside the exit rule set (§15): it is one more reason to
leave, not the only one.

## 6. There is no external signal

The reference engine's external-signal trigger sounds like an integration with
something outside the system. It is not. The market-data service maintains
rolling straddle prices, implied volatility and put-call ratios; it evaluates
conditions on them — *rolling straddle is 10% below its open* — and pushes a
fired "signal" to the trading core, which enters on it.

So the rule already exists. It simply lives in the wrong process, in a
component whose job is to publish prices.

**Garuda moves the arithmetic and keeps the data.** Market data computes
rolling straddles, IV and PCR the same way, publishes them as ordinary ticks
about once a second, and builds their one-minute candles. It evaluates
nothing and decides nothing. The condition that used to fire a signal is
written as a rule here, alongside every other rule, against a price series
like any other.

There is therefore **no external-signal rule, and no external-signal trigger.**
The feature disappears rather than being ported, because what it did is what
this whole document is about.

### Synthetics are instruments

This works because a rolling straddle *is* an instrument. The domain already
says so: `InstrumentKind.SYNTHETIC` is documented as "IV, PCR, straddle price,
synthetic future — priced by the engine, never traded directly. A strategy may
subscribe to one exactly like a real instrument; no order is ever routed for
it." `Instrument.is_tradable` already excludes it, and `synthetic_candles` and
`iv_candles` already exist as tables.

The consequence is the point:

> **Every price, candle and indicator rule works on a synthetic for free.**

"Rolling straddle down 10% from its open" is `percent_from_reference` on the
straddle instrument — the same rule that says "spot down 1% from its open".
NR7 on a straddle series, RSI on a PCR series, a Bollinger squeeze on ATM IV:
all of them already work, and none of them needs a rule written for it. A
family of a dozen bespoke volatility rules collapses into the price and
candle families that were going to exist anyway.

That collapse is the strongest evidence the boundary is in the right place.

### A source is not a rule

The natural next thought is that a synthetic should *be* a rule — one class,
all its logic inside it, plugged in like everything else. That instinct is
right about the shape and wrong about the count. There are two pluggable
things here, and merging them breaks the feature that motivated it.

| | produces | has memory | run by |
|---|---|---|---|
| `SyntheticSource` | the series, tick by tick | yes | market data, continuously, from the open |
| `Rule` | a verdict about the series | no | the rule engine, per strategy, per evaluation |

Take the motivating example. *Rolling straddle is 10% below its open* needs
the session's opening value — and a rule first evaluated at 13:00 gets it by
**reading the day's first candle**, exactly as it would for any instrument.
Market data already stores candles; the open is a lookup, not something the
rule has to have witnessed.

That is the whole reason the rule can stay stateless, and it is why the two
are complements rather than alternatives: **the rule needs no memory because
the source kept it.** Remove the source and the rule does not become
stateful — it becomes blind, because there is no history to read.

What the source is actually carrying, then:

- **Which strike is currently held, and when to roll off it.** That is running
  state, revised tick by tick, and it is the part with no pure formulation.
- **A series that exists whether or not anyone is looking.** A strategy that
  starts watching at 13:00 needs the morning to be there already. Nothing can
  reconstruct it after the fact.
- **One computation for every reader.** Fifty strategies on one straddle
  should be one calculation a second, not fifty.
- **Candles.** A one-minute candle needs every second's value, not the
  instants at which some rule happened to run.

There is also §2 to answer to. Rules are pure, and purity is what lets a
recorded day replay identically and lets the engine reorder by cost. A rule
carrying rolling state is not a rule any more.

So the dividing line is:

> **If it needs memory of anything before this instant, it is a source. If it
> is a pure function of the current context, it is a rule.**

`max_pain_distance` is a rule: it reads today's chain and computes, and has no
past. A rolling straddle is a source. What joins them is that
`percent_from_reference` neither knows nor cares which it is reading.

The two share their plug-in mechanism exactly — a class with its logic inside
it, registered by name, configured by parameters, discovered through an entry
point:

```python
@synthetic("rolling_straddle")
@dataclass(frozen=True)
class RollingStraddle:
    underlying: InstrumentId
    expiry: ExpiryRule = ExpiryRule.NEAREST_WEEKLY
    roll_when_spot_moves: Decimal = Decimal("0.5")   # in strikes

    def price(self, chain: OptionChain, spot: Money, held: StrikeChoice | None) -> Money | None:
        ...
```

Writing a new synthetic is therefore the same act as writing a new rule, and
neither touches the engine. They are simply plugged into different sockets:
one publishes a price, the other reads one.

### The comparison is against the tick, not the close

One consequence deserves to be explicit, because getting it wrong makes a rule
look broken in a way that is hard to see.

*Straddle 10% below the 09:15 open* is a comparison between **the latest
tick** and **a stored candle**. It is satisfied the moment the tick crosses,
not at the end of the minute in which it crossed. A rule that waited for the
candle to close would miss a move that reversed inside the minute — and would
report an entry a minute late on every move that did not.

So the general shape is: **history from candles, present from the tick.**

That forces a small discipline on every rule that mixes the two. The candle
still forming is not history, and must never be read as though it were: the
day's first candle is a fact, the current one is a guess that will change. A
rule comparing against "the previous candle's high" means the last *closed*
one. A rule comparing against "the price now" means the tick.

Indicators sit on the same fault line, and the convention should be stated
once rather than decided per rule: **indicator values come from closed
candles.** An RSI recomputed mid-candle moves as the candle forms and can
cross a threshold and then uncross it before the minute is out — the classic
repainting problem, and it turns a backtest into fiction. A rule that
deliberately wants the forming candle should have to say so by name.

### Two things it costs

- **A synthetic is never a trigger price and never an entry level.** Nothing
  can be bought at a rolling straddle's price; it is an indicator wearing a
  price's clothes. `is_tradable` keeps orders away, and rules that hand a level
  to the entry service must hand a level on a *tradable* instrument.
- **A rolling series is discontinuous.** When the underlying moves enough, the
  straddle rolls to a new strike and the series steps. "Down 10% from the
  open" compares this afternoon's at-the-money straddle with this morning's,
  which is the intended meaning — but it is not a path anything could have
  held. Rules over rolling synthetics should be written knowing that, and the
  definition of each synthetic should record its roll rule so the step is
  explicable rather than mysterious.

**Market data publishes; it does not decide.** That is now a one-line rule,
and the layer contract already enforces its shape: `marketdata` may not import
`engine` or `trademgmt`.

## 7. Rules arm; the trigger price fires

The obvious worry with "everything is continuously evaluated" is latency:
a breakout wants to be acted on in milliseconds, and re-running a rule tree
per tick across every strategy will not do that.

It does not have to. There are already two stages, and the fast one is built:

1. **Rules arm.** When a tranche's entry rules all pass, the strategy resolves
   its legs and emits signals — carrying a **trigger price**.
2. **The entry service fires.** It is already watching ticks, and places the
   order the moment the trigger is crossed.

The tick-speed reaction comes from the machinery that already reacts at tick
speed. A breakout rule does not need to see every tick; it needs to decide
*that we are watching for a break at level X*, and hand X to the thing whose
job is watching.

This is also, exactly, what the reference's breakout-watch table does: arm a
watch carrying the resolved instrument, quantity and entry premium, then fire
on price. The proposal keeps the behaviour and deletes the bespoke table, the
bespoke service and the second lifecycle.

### What paces evaluation

Not a timer. **A rule set is evaluated when a tick arrives for something it
depends on**, which is why a rule declares its dependencies (§11).

That gives the right answer without anyone choosing a number. A rule set
watching only a rolling straddle is evaluated when the straddle ticks — about
once a second, because that is how often it is published. One watching spot is
evaluated on spot ticks. One whose rules are purely about the clock is woken
at the times those rules name, and not otherwise.

Two guards on top:

- **Coalescing.** Ticks arrive in bursts; a rule set is evaluated at most once
  per burst, against the newest values. The tick hub already coalesces this
  way for exactly the same reason.
- **A floor.** A rule set is never evaluated more than N times a second
  however fast its inputs move, and the floor is one number for the engine
  rather than a decision per strategy.

A timer-driven cadence would have been simpler to write and wrong in both
directions at once: too slow for a rule watching a fast instrument, and pure
waste for the several hundred rule sets whose inputs did not move.

## 8. Once-ness belongs to the tranche, not the rule

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

## 9. What a rule can see

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

## 10. Most rules must not remember anything

State across evaluations is where replay and restart break. The default is
that a rule derives everything from history: "three consecutive green
candles" reads three candles, it does not count them as they happen.

`memory()` exists for the few that genuinely cannot — "the first breakout of
the day", "we already retested" — and is opt-in, keyed by
`(subscription, tranche, rule)`, and persisted with the strategy's state so a
restart does not lose it. A rule using memory should say so in its
registration, because it is the thing that makes a replay diverge.

## 11. Plugging in a new rule

Registration by name, not by inheritance:

```python
@rule("narrow_range", cost=Cost.CHEAP)
@dataclass(frozen=True)
class NarrowRange:
    """NR7 and its family: today's range the narrowest of the last n."""

    lookback: int = 7
    interval: str = "1d"

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        candles = context.candles(context.underlying, self.interval, self.lookback)
        if len(candles) < self.lookback:
            return unavailable(
                f"only {len(candles)} of {self.lookback} {self.interval} candles"
            )
        today, before = candles[-1], candles[:-1]
        if today.range < min(candle.range for candle in before):
            return passed(f"range {today.range} is the narrowest of {self.lookback}")
        return failed(f"range {today.range} is not the narrowest of {self.lookback}")
```

- The decorator registers a **name** and a schema derived from the dataclass
  fields. Configuration stores `{"type": "narrow_range", "lookback": 7}`.
- Out-of-tree rules register through a `garuda.rules` entry point, the same
  mechanism `DESIGN.md` already reserves for third-party evaluators. Installing
  a package makes its rules configurable; nothing in core changes.
- **An unknown rule type is refused at save time and at load time**, never
  ignored. A rule silently dropped turns "enter only if volatility is low"
  into "enter", which is the most expensive failure mode this feature has.
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

## 12. Safety

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

## 13. A catalogue

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

**Statistics over history** — any instrument, synthetic or real
`percentile_of_history(lookback)` · `rank_in_history(lookback)` ·
`zscore_from_mean(lookback)` · `at_extreme_of(lookback)`

These are where the volatility family went. "IV percentile" is not an IV idea,
it is a history idea applied to an IV series, so one rule covers IV percentile,
PCR percentile and straddle-price percentile at once.

**Volatility and option structure** — what is left after §6
Almost nothing, and that is the point. VIX, ATM IV, IV skew, PCR, the rolling
straddle and the synthetic-future basis are all **instruments**, so
`price_above`, `price_below`, `percent_from_reference`, `indicator` and the
statistics above already cover them. What genuinely remains needs the whole
option chain at once rather than one series:
`max_pain_distance` · `option_premium_between` · `chain_skew_shape`

**Liquidity and microstructure**
`min_volume` · `min_open_interest` · `oi_change_percent` ·
`max_spread_percent` · `min_depth_quantity(levels)` · `not_near_circuit`

**Position and portfolio state** — mostly, but not only, exits
`no_existing_position_in` · `max_open_positions` · `max_trades_today` ·
`daily_loss_below` · `daily_profit_below` (stop after the day's target) ·
`unrealised_pnl_percent` · `time_since_entry` · `breakeven_reached` ·
`hedge_present` (refuse a naked short if its hedge is gone)

**Calendar and regime**
`event_day` / `not_event_day` · `news_blackout` · `market_regime` (a named
classification, once something publishes one — as an instrument, naturally)

There is no `external_signal`. See §6.

**Composition**
`all` · `any` · `not` · `at_least(n, rules)` · `ref(name)` — a named,
reusable rule set, so common filters are written once and referenced from many
strategies rather than copied into each.

## 14. Configuration

Rules are list-valued, and the per-field merge in `engine/config.py` handles a
list badly: half-overriding a list is a footgun with no good semantics. So:

- `entry_rules`, `direction_rules` and `exit_rules` are **single JSON fields**
  on the configuration. A narrower scope replaces the whole list, it does not
  merge into it. Predictable, and easy to explain.
- Reuse comes from `ref` and named rule sets, not from list merging. A tranche
  that wants the base filters plus one more writes
  `{"type": "all", "rules": [{"type": "ref", "name": "morning-filters"}, ...]}`.

## 15. Decided

1. **Exit rules are `all`, like entry.** The worry that an `all` exit might
   never fire was misplaced, because exit rules are not the only way out. The
   stop, the target and the square-off deadline are all still live and any of
   them fires on its own. An exit rule set is an *additional* reason to leave,
   evaluated before any of those trigger — a way to get out early on
   conditions, not the mechanism that gets a position out at all.

   So a position exits when **the stop fires, or the target fires, or the
   square-off time arrives, or every exit rule passes.** Entry and exit rule
   sets are configured separately per strategy, and neither has to resemble the
   other.

2. **Direction rules do not veto.** They answer a direction or decline to have
   an opinion; standing a strategy down is an entry rule's job. Keeping the
   two apart means "which way" and "whether at all" stay separately testable.

3. **The evaluation floor is ten a second** per rule set. Generous for inputs
   published once a second, and cheap across a few hundred sets.

4. **The catalogue starts** with `all` / `any` / `not`, `at_or_after`,
   `before`, `indicator`, `breakout` and `price_below`. Those carry every
   shape configured today. Everything else is additive by construction.

5. **Synthetics are declared per symbol.** *(Built: declared per underlying
   anything is subscribed to, which is narrower and better — a rolling
   straddle for a symbol nobody trades is a chain subscription and a
   calculation every second for a series nobody reads.)* The `symbols` table already lists
   the underlyings worth caring about, and it is the natural place to say which
   of them maintain a rolling straddle, an implied-volatility series or a
   put-call ratio. No new table: a synthetic is a property of an underlying,
   and the roll rule belongs beside the strike gap that determines it.
