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
- **Nothing constructs any of this.** Every piece is built and tested, and
  no composition root wires a book, a tracker, a coordinator, a square-off
  queue and a loop together for a real account. That is the next thing, and
  it is where integration problems will surface.
- **A hedge exiting first does not close the main it protected.** The
  reference engine reserves an exit reason for that direction and never wires
  one, so the position runs unhedged. Ours alerts loudly and closes nothing,
  because whether to replace the hedge or exit the position is a strategy
  decision the owner has not made. Worth deciding.
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
- **Market data account and per-client streams are not wired at startup.**
  The resolver, the feed and the stream manager all exist; nothing composes
  them into a running engine yet.
