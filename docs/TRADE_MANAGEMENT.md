# Trade management: analysis of the reference engine, and the port

Trade management is the largest single subsystem in the reference engine and
the one where a mistake costs money rather than a restart. This is the reading
that precedes the port: what is actually in there, what each part is for, and
what changes because Garuda is a different product.

## 1. Scale

| Class | Lines | What it is |
|---|---:|---|
| `UserBrokerTradeManager` | 9,566 | Everything that happens to one account's trades |
| `TradeManager` | 3,571 | Singleton: owns the processors, the tick cache, cross-account queries |
| `TradeStorage` | 2,337 | Durability for live trades and signals |
| `Trade` | 601 | ~150 fields |
| `TradeProcessor` | 534 | The thread that drives a partition of accounts |
| `TickFallbackWatchdog` | 521 | REST polling when the feed stalls |
| `TradeSignal` | 286 | ~80 fields |
| Supporting | ~1,100 | Dispatcher, watchdog, P&L accumulator, keys, enums |
| **Total** | **18,534** | |

## 2. The three layers

```
TradeManager                    one instance
  ├── live tick cache, CMP lookup, quote cache
  ├── cross-account queries (by strategy, by group, by definition)
  ├── square-off by trade id
  └── owns N TradeProcessors

TradeProcessor                  one thread per partition of accounts
  └── loop: for each account —
        fetchAndUpdateAllTradeOrders()   poll the broker's order book
        trackAndUpdateAllTrades()        advance every trade
        evictEligibleTerminalGroups()    free memory

UserBrokerTradeManager          one per account
  └── the entire trade lifecycle for that account
                                (ported as TradingClientManager -- see 2a)
```

The important structural fact: **nothing schedules trade management except the
processor loop.** There is no reconciler service and no second timer. The poll
is a method, and the loop is its only caller.

## 2a. Names in the port

The identity change -- `username + broker` becomes one trading client -- makes
the reference engine's names wrong rather than merely long. The mapping:

| Reference engine | Garuda | Why |
|---|---|---|
| `UserBrokerTradeManager` | `TradingClientManager` | One per account; owns that account's whole trade lifecycle |
| `TradeManager` | `TradeManager` | Unchanged: it owns the client managers and the cross-account view |
| `TradeProcessor` | `TradeLoop` | It is a loop, not a pool of threads over a partition |
| `UserBrokerKey` | *(gone)* | A `TradingClientId` is already the key |

`TradingClientManager` reads two ways -- "the manager for a trading client"
and "the thing that manages trading clients" -- so the second meaning is
deliberately given a different word: the account records themselves are
created and edited through a **registry**, never a manager. Nothing in the
codebase called a manager does CRUD on accounts.

## 3. The lifecycle

```
TradeSignal ──(tick crosses trigger)──► Trade(OPEN)
                                          │  entry order placed
                                          │
                       first fill ────────▼
                                       Trade(ACTIVE)
                                          │  SL order placed
                                          │  target order placed
                                          │  trailing SL tracked per tick
                                          │
     SL hit / target hit / square-off ────▼
                                     Trade(COMPLETED)

     entry rejected / unfilled / expired ►Trade(CANCELLED)
```

`TradeState` replaced a two-boolean encoding (`isActive` + `isCancelled`), and
the mapping is recorded in that enum because the old form is still in persisted
data. Garuda starts with the four states and never has the booleans.

`TradeExitReason` has **52 constants**. That is not clutter: an operator
reading a closed trade needs to know whether it exited on its own stop, on a
group stop, because its hedge went first, because the strike became worthless,
or because a square-off exhausted its attempts. The list is the vocabulary of
the whole subsystem and ports nearly whole.

## 4. What is actually inside the 9,566 lines

Grouped by concern, with the line ranges they occupy:

| Concern | ~Lines | Ports? |
|---|---:|---|
| Load, retention filters, restart recovery | 700 | Yes |
| Signal intake and duplicate rejection | 320 | Yes |
| Strategy / group listing indexes | 250 | Yes |
| **In-memory eviction of terminal trades** | 370 | **No — scale** |
| Signal trigger → execute trade | 760 | Yes |
| Broker order-book poll and reconcile | 420 | Yes |
| Per-trade tracking core | 730 | Yes |
| Entry order tracking | 380 | Yes |
| SL order tracking | 340 | Yes |
| Target order tracking | 210 | Yes |
| Placing SL and target orders | 630 | Yes |
| Trailing stop-loss | 350 | Yes |
| Combined SL+target on one order | 270 | Yes |
| **Bracket/cover second-leg tracking** | 110 | Decide |
| Quantity and position helpers | 80 | Yes |
| Hedge resolution | 130 | Yes |
| Order fill escalation | 220 | Yes |
| Square-off queue and worker | 590 | Yes, simplified |
| Square-off execution | 850 | Yes |
| Pair / hedge / combo finders | 290 | Yes |
| Queries and getters | 280 | Yes |
| Alter trade details (operator edits) | 110 | Yes |

### The scale machinery

A significant fraction of the subsystem exists to survive thousands of
concurrent users, which Garuda explicitly is not:

- **`TradeProcessor` partitioning** — accounts sharded across threads. Garuda
  runs one event loop and a handful of accounts.
- **`SquareOffDispatcher`** — a fair-share thread pool so one slow broker
  cannot starve users on other brokers via head-of-line blocking.
- **Active-trade eviction** — terminal trades removed from the working set to
  bound memory, with correlation-group gating so a hedge pair is evicted
  together.
- **`TradeStorage` writer threads** — async batched persistence with a 30s
  sweep, because synchronous writes could not keep up.

None of that is wrong; all of it answers a question Garuda does not ask. It is
roughly 2,000–2,500 lines that become a plain `async` loop and a direct write.

### The parts that look like scale machinery but are not

- **Coalesced alert keys** (`retryWindowClosedAlerted`, `exitPlacementCapAlerted`,
  `worthlessExpiryExitAlerted`, `alertedKeys`). These stop *one* trade flooding
  the operator, not a thousand users. Already ported as alert coalescing.
- **`squareOffAttempts` / `exitPlacementAttempts` caps.** A square-off that
  cannot fill must stop trying and say so, or it places orders forever.
- **Order fill escalation.** A limit entry that does not fill escalates —
  market, percentage steps, level-N of the book, or best bid/ask.

## 5. What the port changes

**Dropped** (per `SCOPE_DECISIONS.md`): mock sessions and every `isMock` branch,
the external-signal bridge, licensing and seat checks, per-user portal events.
Paper trading is **kept** — it is a property of a subscription.

**Renamed by necessity:** `username + broker` becomes `trading_client_id`
throughout, which collapses `UserBrokerKey` and every map keyed by it.

**Structural:** one 9,566-line class becomes roughly eight modules along the
concern boundaries above. They are already separable — the class is large
because it grew, not because the concerns are entangled. The evidence is that
each concern has its own field group and its own entry point.

## 6. Build order

Each step ends with something that runs and tests that prove it.

**Done: 1-9.** The port's build order is complete; what remains is in section 8.

1. ✅ **The model.** `Trade`, `TradeSignal`, `TradeState`, `TradeExitReason`, and
   the state machine. Pure domain, no I/O.
2. ✅ **The book.** One account's trades and signals in memory, with the strategy
   and group indexes, duplicate rejection, and restart load.
3. ✅ **Entry.** Signal trigger evaluation against a tick, entry order placement,
   fill tracking, and the entry-failure funnel.
4. ✅ **Protection.** SL and target placement, the combined-order variant, and the
   attempt caps.
5. ✅ **Tracking.** The per-trade advance: order updates in, state transitions out,
   plus the broker order-book poll that backs it.
6. ✅ **Trailing.** Tick-based trailing SL, trail-to-cost, and the trailing modes.
7. ✅ **Exit.** Square-off queue, the worker, retry policy, attempt caps, and the
   exit reasons.
8. ✅ **Relationships.** Hedge, pair and combo resolution, and the consequences one
   leg's exit has for another.
9. ✅ **The loop.** The processor that drives it, wired to the day phases.

Escalation and operator edits (`alterTradeDetails`) fold into 3 and 7.

## 7. Scope, decided

**Bracket and cover orders: dropped until asked for.** Several brokers have
withdrawn them and `brokers.bo_co_blocked` exists because of it. The second-leg
tracking, the BO/CO branches in placement, and the separate SL/target order
lists all go. `ProductType` keeps `CO` and `BO` so configuration and persisted
data still round-trip, and the Zerodha adapter keeps its variety routing --
adding the tracking back later is additive.

**In scope for v1**, all four:

- **Re-entry after a stop.** `reEntryCount` and `maxTradesPerStock`: re-enter
  the same symbol after a stop, up to a cap, optionally reversed.
- **Order fill escalation.** A limit entry that will not fill escalates -- to
  market after N seconds, or through configured steps: percentage buffer,
  level-N of the book, best bid/ask.
- **Hedge replace windows.** Morning and evening switching of hedge distance
  (positional 1% to intraday 4% and back), with its own state machine and
  restart recovery.
- **Corporate actions on open trades.** `ca_factor`, `original_quantity`,
  `original_entry` and the applied-action ids, so a split or bonus on a held
  position leaves P&L correct.

The three optional ones each attach to a stage of the build order rather than
forming a stage: re-entry and escalation to entry, hedge replace to
relationships, corporate actions to the book.


## 8. Carried forward

Deferred deliberately, not forgotten. Each is named where it would otherwise
be discovered as a gap.

- **`PriceBand` has no source.** The protective-order service takes a lookup
  for the day's circuit limits and nothing supplies one; it needs the quotes
  API on the market-data side. Until then every limit target defers as
  `NO_QUOTE`.
- **Dynamic SL and target.** The reference computes both from a live quote
  shortly after entry when the strategy asks for it. Belongs with tracking,
  since the first fill is what triggers it.
- **Strategy subscriptions.** `EntryService` takes an `is_subscribed` check
  and nothing feeds it, so subscription state is not enforced at entry.
- **A hedge exiting first does not close the main it protected.** Settled: by
  design this cannot happen. Legs enter protection-first and exit in the
  reverse order, so the main always leaves before its hedge — `exit_order` is
  the reverse of `entry_order`, and `LegCoordinator` pulls the hedge when the
  main goes. The alert stays as it is: reaching that branch means an invariant
  has broken, not that a business case needs designing. Nothing to decide, and
  nothing more to build.
- **Indicator-based trailing modes.** ATR, EMA, SuperTrend and Heikin Ashi
  all need candle history and indicators the engine does not have. A strategy
  configured for one is refused with an alert rather than trailed some other
  way, so the gap is loud.
- **Per-broker trading symbols.** Each broker now has its own registry, so
  tokens are already separate. Trading symbols are not: a registry's symbol
  index is built from that broker's own master, which is right, but nothing
  yet reconciles two brokers spelling one contract differently. That surfaces
  when the second broker is added and its master can be compared against the
  first.
- **Segments are not a column.** `exchanges` now carries `currency` — added
  here deliberately, since the reference engine is single-market and never
  needed it — but still does not say what a venue *trades*, so
  `composition/venues.py` carries a table of three. A fourth venue needs a
  column, not an entry in that table.
- **One stop-loss gap for every venue.** `ProtectiveOrderService` caps a
  strategy's stop distance by a per-segment maximum; the composition root
  supplies a single constant because nothing stores one. It belongs beside
  the other per-segment limits.
- **`OrderChanges` is not built anywhere.** Trailing modifies a standing stop
  through the broker's `modify`, and the composition root passes it straight
  through. Nothing yet decides *what* to change on a partial modification —
  price only, or price and trigger — per broker.


## 9. What the composition root does

`garuda.composition` is the one place allowed to see every layer at once, and
import-linter now says so — it sits above `api` in the layer contract.

`build_engine` constructs; `runtime.start` starts. The split is what lets a
test inspect a fully-built engine without opening a socket or advancing a
clock, and it is worth keeping.

What it wires today:

- **Venues** from `exchanges` and `holidays`, including each venue's own day
  offsets, so `EngineRunner` schedules a day per venue rather than per engine.
- **Accounts and sessions** through `SessionResolver`, which resolves a
  dealer's borrowed token as readily as an account's own.
- **The feed**, on whichever account is nominated for market data, with one
  `TickHub` shared by every client — a price is a fact about the market, not
  about an account.
- **Per client**: a Kite REST client routed through that account's static IP
  if it has one, a book, a tracker, entry, protective, trailing, square-off
  and coordination services, a trade loop, and a persistence sweep.
- **Order updates**, routed by the client id on the payload rather than by the
  socket they arrived on.
- **`garuda seed`, `garuda check`, `garuda run`** — `check` builds everything
  and reports who can trade without touching a socket or writing to disk.

**An account that cannot be built does not stop the others.** A disabled
account, an expired session and a missing login are each reported by name and
the rest of the engine is assembled. At six in the morning nobody has logged
in, and an engine that refuses to start then is an engine nobody can use.

### What it still cannot produce

A trade — but the gap is now one step, not two.

`engine/signals.py` joins the two halves: it takes an evaluator's `Intent`s,
sizes each leg, and emits the `TradeSignal`s trade management consumes.
`composition/routing.py` delivers a batch to the account it names. What is
missing is upstream of both — nothing loads a `StrategySpec` from
configuration, so no evaluator ever runs and no intent is ever produced. That
is the strategy engine, and it is the next large piece.

## 10. From intent to signal

Three rules, each the safe direction to be wrong in:

- **A partial entry is worse than none.** If any leg cannot be resolved,
  priced or sized, the whole combo is refused. A short option whose hedge was
  dropped for want of one lot is not a smaller version of the position that
  was designed — it is a different position with a different worst case. The
  evaluator already stands aside on an unresolvable leg; sizing holds the same
  line, and delivery withdraws a combo whose leg turns out to be already held.
- **A position above the freeze limit is several signals.** One signal becomes
  one trade becomes one order, so the split has to happen at signal time. Each
  slice carries its own ordinal, its own protection and its own protective
  order.
- **Ids are derived from the correlation id, never random.** A replay that
  renames everything proves nothing about duplicate detection.

**Slicing exposed a defect in duplicate detection.** `_duplicate_option_side`
refuses a second signal for the same option side in the same group — the shape
"one leg, sized twice" takes. Two slices of one leg have exactly that shape, so
every slice after the first was refused, and an account would have ended up
holding a fraction of the size that was intended with nothing saying so. The
rule now exempts a candidate that is the same instrument in the same tranche
with a *different* slice ordinal. Two independent sizings both carry ordinal 1
and are still caught, which is the case the rule exists for.

### Combined stop-loss and target

Settled, and specified here because the arithmetic is easy to get subtly wrong.

A combined level is measured against the **net premium of the group**, not
against any one leg. Net premium is what the position took in less what it
paid out:

```
net = Σ over legs of  entry_price × quantity × (+1 if short, −1 if long)
```

A short call at 150 and a short put at 120, equal quantities, is 270 taken in.
A 10% combined stop is 27 against that — the position comes out when closing
it would cost 297. A 10% combined target is the mirror: out at 243.

Two things this settles:

- **Hedges count.** A bought hedge reduces the net premium and so moves both
  levels. It matters when the hedge sits near the sold strike and is
  negligible when it is far out — which is an argument for always including it
  rather than for a rule about when to.
- **Quantities are weighted in, not assumed equal.** The example above works
  in premium points because a straddle's two legs are the same size. A hedge
  at half the main leg's ratio is not, and points would silently misweight it.

Each leg keeps its own stop as well. The combined level is an additional exit
for the group, in the same way an exit rule set is (`STRATEGY_RULES.md` §5):
whichever comes first.

**Built.** `trademgmt/combined_rules.py` holds the arithmetic and
`trademgmt/positions.py` runs it, once per tick, for every group holding the
instrument that ticked. Three things it settles that the specification above
left implicit:

- **Where the percentages live.** On the leg, in `Protection`, resolved at
  signal time with the day conditions in hand and persisted with the trade.
  Not looked up from configuration at tick time: the level cannot be a price
  until every leg has filled, and the conditions that resolved it are gone by
  then.
- **A group with a leg still resting cannot be valued.** It comes back
  UNAVAILABLE rather than being measured on the legs that did fill. A straddle
  with one side unfilled is not a one-legged straddle, and reading it as one
  fires the combined stop on half a position.
- **The levels are the group's, not the first leg's.** Legs carrying no
  combined percentages are ignored, so a hedge added without them does not
  turn the group's stop off. Legs carrying *different* ones leave the group
  with no level at all and say so loudly — picking a winner would apply a stop
  nobody configured.

A group is asked out once. The level stays true on every tick after it is
crossed, and re-asking would bury the log; the square-off queue is idempotent
per trade regardless.

**The group's stop trails too**, from `combined_trail_sl` and the
`combinedProfitGap` / `combinedSlMoveGap` / `combinedTrailMode` keys in the
same `trail_config` column the per-leg trail reads. One column, two trails,
and they share no gap: a leg trailing on points has nothing to say about a
group trailing on per cent of its premium. The group trail is in per cent by
default and the leg trail in points, which is the reference's default for
each.

The floor walks up from the configured stop, one move gap per whole profit
gap the group has earned, measured against the best the group has been. Below
the first step the configured level stands unmoved — that is what makes it a
trail rather than a second stop. Whole steps, so the level does not jitter
with every tick.

Three checks in this order, and the order is the reference's: the configured
stop, then the trailed one, then the target. A group past its fixed stop is
out on that whatever the trail says, and a group walking away from its target
is out on the trail rather than left to run at it.

**Where the high-water mark lives is the one thing decided differently from
the reference.** It keeps the group's best in a map in memory, so a restart
loses it and the trail begins again from the configured stop — giving back
everything the group had earned. Here it is written onto every leg, in
`Protection.combined_high_water`, the way the group's percentages already
are: a leg is what survives a restart, and a group is not an entity that can
hold anything. Written only when it moves, so the persistence sweep has
nothing to write on a tick that changed nothing.

### Trailing a stop off closed bars

Four of the reference's five trailing modes are built. `RISK_MULTIPLE` needs
nothing but the price and runs on every tick; `ATR`, `EMA` and `SUPER_TREND`
read an indicator over closed bars and are recomputed at most every fifteen
seconds per trade — their level cannot move until a bar closes, so asking on
every tick is a hundred bars of arithmetic for an answer that has not changed.
The reference holds the same interval for the same reason.

**The mode chooses the calculator.** A strategy trailing by ATR is not also
trailing by risk multiples: they are different strategies, and offering both
would take whichever happened to be tighter, which is neither. Trail-to-cost
is not a mode but a flag, and applies whichever mode is running.

What each mode reads differs in one way that matters. ATR is a *distance*, so
the stop sits that far from the close and a widening range loosens the level —
refused, because a stop that can move away from the price is not a stop. EMA
and SuperTrend are *levels*, and the stop rides a buffer behind. SuperTrend
flips sides with the trend, so it only trails while the close is on the
favourable side of it: on the wrong side the line is where the *opposite*
position's stop would go.

`HEIKIN_ASHI` is not built. It needs a Heikin-Ashi candle transform, a search
back for the most recent candle with a wick on the right side, and a cap on
how far the stop may sit from the extreme — none of which anything else uses.
A strategy configured for it is refused by name and keeps its stop.

The candle history is the engine's own `CandleCache`, the same one the rules
read, so a strategy trailing by SuperTrend and a rule testing SuperTrend see
the same bars. Trade management sits below market data, so it takes a narrow
`CandleView` rather than importing a cache — the way it already takes quotes
and instruments.

### One pass over what is open, every tick

Entry asks what a price means for a signal. A second pass asks what it means
for everything already in the book, and until now there was no such pass:
`TrailingService` was constructed into every account and nothing ever handed it
a tick, so trailing stops never moved and the high and low since entry — which
trailing measures from — were never recorded.

The two are guarded separately in the fan-out. Entry failing on a tick must not
stop a trailing stop moving or a combined level being read; those protect money
already at risk.

### Risk gates every order, and gates an exit differently

A breach must stop an account taking *more* risk and must never stop it
leaving the risk it has. A limit that blocked a stop-loss would turn a bad day
into an uncapped one.

That does not mean exits go out unchecked. Every order passes the gate; on an
exit the checks that could only prevent closing stand down, and each check
answers for itself whether it has any business stopping one. Of the eleven,
two say yes — the market being open, and the exchange's freeze quantity. Both
are conditions the exchange would refuse on anyway, and being told here names
the reason more clearly than a broker rejection does. The rest — the kill
switch, the daily loss limit, order size and value caps, and every check that
needs a usable quote — stand down. Not knowing the price is a reason not to
open a position and never a reason to keep one.

An `OrderRequest` cannot tell an entry from an exit, so the distinction is made
where it is known rather than carried on the request: the entry service and the
protective and square-off services are wired with two different placements off
the same gate. The reference engine draws the same line from the other
direction, with a `skip_price_validation_for_exit` flag on its configuration
and an explicit "always allow closing positions" on the checks it bypasses.

One check runs on exits and nowhere else: an exit may not be for more than
the book says is open on the side it closes. The bound is the engine's own
book, gross per direction — two strategies holding opposite positions in the
same instrument net to nothing and each has a real position to close — and
never the order's own claim, which is what it guards against. No bound
supplied means no opinion: refusing because nothing could be checked would
strand a position, which is the failure the check exists to prevent. The
reference engine reconstructs the same invariant from broker net positions
through a chain of fallbacks, because its exits reach the validator with no
link to the trade they close; here the book is in process and the number is
exact, so the fallbacks are not ported.

One more check runs on entries only and needed the book to exist: a cap on
how much of one instrument may be held one way at once. It is measured against
what the book holds **plus what it has resting**, because the failure it
catches is a signal firing twice — the first entry is still unfilled, so a
check against filled quantity alone sees nothing and lets the second through.
The reference engine added its own version for exactly that, and calls it out
as preventing "bugs that fire duplicate entry signals from building excessive
positions".

The cap is in units, not money. That is what `rms_config.max_position_qty_per_symbol`
holds and what the reference configures; `max_order_value` is what caps a
single order's money. A `max_position_value_per_symbol` limit had been declared
here with no column populating it and no check reading it, and is gone.

The kill switch is the one an operator would guess wrong: it stops an account
taking risk and must never stop it closing. It is also not yet reachable —
`kill_switches` is a table with no runtime service behind it, so nothing sets
the reason the check reads. The market-open check *is* reachable: the gate
asks the venue's own calendar, which it did not before, and an order outside
the session is now refused by name rather than by the broker an hour later.

A refusal is raised as `OrderRejectedError`, which is what trade management
already reads as "no order exists, so a later attempt may safely send a fresh
one". Any other exception leaves it believing an order might be resting at the
exchange, and it will not place again.

### Not decided yet

- **Where stop and target levels come from.** Settled and built: per-leg
  levels, combined levels and trailing all come from the strategy's own
  resolved configuration through `engine/protection.py`, and ride on the leg.

  The `*_policy` tables are not loaded, and that is not a gap. In the
  reference engine they are Console-side *templates*: `trailing_sl_policy`
  has a unique `policy_name` and nothing keys to it, and what a strategy
  actually trails on is whatever the Console copied into its own
  `trail_sl_type` and `trail_config` columns. Reading the policy table at run
  time would be reading a menu rather than an order. `sl_target_policy` and
  `exit_policy` are the same shape; they become real when the Console does.

  One thing to know before offering those templates in a Console: two of the
  reference's own rows are unusable as data. `TRAIL_0.5_BUFFER` and
  `TRAIL_1_BUFFER` are typed `PERCENTAGE` with an empty `trail_config`, so the
  buffer each is named for exists only in the name and the description.
- **Where capital comes from.** Settled — see `STRATEGY_ENGINE.md` §5 for the
  chain. `build` still takes it as an argument and nothing reads the tables
  yet.
- **Group and tranche.** Both are parameters with defaults. Tranche scheduling
  is not built.
