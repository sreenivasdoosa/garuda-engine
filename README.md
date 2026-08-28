# Garuda Engine

> A venue-neutral, event-driven algorithmic trading engine for Indian markets, in Python.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Python](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/)

Garuda Engine is a broker-agnostic trading engine: you write strategies against a
small, stable interface, and the engine handles market data, order routing, risk
gating, position tracking and reconciliation across multiple brokers.

**v1 targets** Indian equities and F&O (NSE/BSE) and commodities (MCX), plus a
paper broker. The venue model is designed for — but does not yet ship — US and
other international exchanges.

---

## ⚠️ Risk disclaimer

**Read this before you run anything.**

This is software for automating trading decisions. Trading in securities and
derivatives carries substantial risk of loss, and automated systems can lose
money faster than manual ones.

- This project is **software**, not investment advice. It makes no
  recommendation about what, when, or whether to trade.
- The author is not a registered investment adviser or research analyst.
- Any strategies, parameters, or examples included are illustrative only.
- Shadow-mode results do not predict live performance. Slippage, latency,
  partial fills, and broker outages are real and will differ from simulation.
- **You are solely responsible for every order this software places on your
  behalf**, including orders resulting from bugs, misconfiguration, or
  unexpected market conditions.
- Run in shadow mode until you fully understand the behaviour. Start small.

Provided **as is**, without warranty of any kind. See [LICENSE](LICENSE).

---

## Status

**Early / alpha — Phase 1 (skeleton).** Interfaces may change without notice
before v1.0. Not yet recommended for unattended live capital.

See [Roadmap](#roadmap) for what lands when.

---

## Features

- Event-driven core — ticks and bars in, order intents out
- Venue as data, not code — currency, timezone, calendar, tick and lot size,
  settlement and exercise style live on `Exchange` and `Instrument`
- Pluggable broker adapters, discovered via entry points
- Position and P&L tracking with exact decimal arithmetic — no floats in any
  money or price path
- State derived from an append-only journal, so recovery, audit and
  deterministic replay all come from one mechanism
- Full order lifecycle: placement, modification, cancellation, retries, and a
  total, explicit state machine
- A `RiskGate` between every intent and every order — position limits, daily
  loss limits, order value caps, allow-lists, rate limiting, kill switch
- Reconciliation against broker state on restart, which halts rather than
  guessing
- Strategies as ordinary Python packages — no fork required

### Not included

- **No backtester.** This is a deliberate design decision — see
  [Why there is no backtester](#why-there-is-no-backtester).
- Not an HFT or latency-arbitrage system. The target is systematic trading at
  seconds-to-minutes granularity, not microseconds.
- No custody and no order matching — this is not a broker.
- No strategy recommendations shipped in core.
- No multi-tenant account management, RBAC, or compliance reporting.

---

## Why there is no backtester

The engine ships no historical data loader, no backtest runner, and no
equity-curve reporting. The reason is data quality, not implementation
difficulty:

- **Options history is largely unavailable.** Complete strike-and-expiry chains
  for Indian markets barely exist for earlier years, and what exists is partial.
- **Intraday OHLC is unreliable.** Broker candle APIs reconstruct bars from
  periodic snapshots rather than true tick aggregation, so intraday highs and
  lows are frequently wrong — precisely the values a stop-loss or breakout
  strategy depends on.
- **Vendor archives are inconsistent** in format, symbology and field semantics,
  requiring a repair pipeline that is itself a source of silent error.

A backtester built on this data does not fail loudly. It produces confident,
specific, wrong numbers — and those get traded with real capital.

**The supported validation path is shadow mode** (below). Deterministic replay
of the engine's own journal exists, but as test infrastructure, not as a
strategy research tool. If you have data you trust, a backtester can be built as
a plugin package against the existing protocols; it will not live in core.

---

## Shadow mode

The supported way to validate a strategy before committing capital:

```
live market data feed
   ↓
Strategy                 real prices, real timing
   ↓ Intent
Sizer → RiskGate         identical to live
   ↓
Router ──────────────→   PaperBroker   (no capital at risk)
```

Everything upstream of the router is the same code path that runs live. The
strategy sees genuine spreads, liquidity, gaps and feed interruptions — the
conditions historical bar data cannot reproduce.

Simulated fills model spread, slippage and rejection explicitly, with the
assumptions logged; a fill at mid is a lie and is not the default. Output is
deliberately behavioural — intents, fills, rejections, position states — not a
headline return figure. Run at least one full expiry cycle in shadow mode before
any live deployment.

---

## Quick start

```bash
pip install garuda-engine
```

```python
from garuda import Engine, Strategy, Context
from garuda.brokers.paper import PaperBroker


class MyStrategy(Strategy):
    def on_bar(self, bar, ctx: Context):
        if bar.close > ctx.params["threshold"]:
            yield self.buy(bar.instrument, qty=1)


Engine(broker=PaperBroker(), strategies=[MyStrategy()]).run()
```

Callbacks return **intents**, not orders. The engine sizes, prices, risk-gates
and routes them — which is what makes a strategy portable across venues and
testable without a broker.

Full walkthrough: [docs/getting-started.md](docs/getting-started.md)

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Strategy layer          user code, plugin packages       │
├──────────────────────────────────────────────────────────┤
│  Engine core             venue-neutral, no I/O            │
│    Router · RiskGate · OrderManager · PositionBook        │
├──────────────────────────────────────────────────────────┤
│  Domain model            Money · Instrument · Exchange    │
├──────────────────────────────────────────────────────────┤
│  Adapter layer           all venue-specific code          │
└──────────────────────────────────────────────────────────┘
```

Dependencies point downward only. The core imports no adapter.

Four protocols form the public contract; changing them is a breaking release:

| Interface | Purpose | Implement it when |
|---|---|---|
| `BrokerAdapter` | Auth, orders, positions, market data, instrument master | Adding a new broker |
| `Strategy` | Receives market events and position state, emits intents | Writing your own logic |
| `EventBus` / `Store` | Transport and persistence | Changing deployment shape |
| `Clock` | Time, abstracted for deterministic replay | Almost never — it is test infrastructure |

Strategies never talk to the broker directly. Adapters never contain strategy
logic. Keeping that boundary is what makes upgrades painless.

Deeper detail: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Extending without forking

Custom brokers and strategies ship as separate packages and are discovered via
entry points. You never need to modify this repository to use your own:

```toml
[project.entry-points."garuda.brokers"]
mybroker = "my_package.broker:MyBroker"

[project.entry-points."garuda.strategies"]
my_straddle = "my_package.straddle:ShortStraddle"
```

Core carries the paper broker and a reference adapter only. Every other adapter
lives in its own repo with its own tests, so a broker API change breaks one
package rather than the release.

If something can't be expressed through the existing interfaces, open an issue —
the fix is usually to widen the interface upstream, which helps everyone.

---

## Supported brokers

| Broker | Market data | Orders | Status |
|---|---|---|---|
| Paper (simulated) | ✅ | ✅ | Phase 1 — in progress |
| Zerodha (Kite Connect) | — | — | Phase 2 — planned |
| Second live broker | — | — | Phase 4 — planned |

A new adapter is correct when it passes the **adapter contract test suite**, so
a reviewer does not need broker access to review one.

Broker names and API references are trademarks of their respective owners. This
project is not affiliated with, endorsed by, or supported by any broker.

---

## Roadmap

| Phase | Scope |
|---|---|
| 1 | Skeleton — domain model, protocols, paper broker, one trivial strategy end to end, journal replay proving determinism |
| 2 | One live broker — full order lifecycle, reconciliation, risk gate, shadow mode; NSE equities and F&O |
| 3 | MCX — forces the session and trading-day abstraction to be correct |
| 4 | Second broker — the real test of the adapter interface; expect revisions here |
| 5 | Open the door — adapter contract suite, contributor docs, CLA |

Nothing ships beyond Phase 1 until the seams are proven clean.

---

## Contributing

Contributions are welcome — especially broker adapters, tests, and docs.
Realistically, outside contribution becomes practical at Phase 5, once the
adapter contract suite exists.

Before your first pull request, please sign the
[Contributor License Agreement](CLA.md). This is required: it lets the project
be offered under a commercial licence alongside the AGPL, which is what funds
continued maintenance. Without it, contributions cannot be merged.

Please also read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, coding standards,
and the review process.

Note on scope: changes to order execution, position state, and P&L arithmetic
are reviewed strictly and require accompanying tests. Bugs there cost real
money, so review may be slow. That is deliberate.

---

## Licence

Licensed under the **GNU Affero General Public License v3.0** — see
[LICENSE](LICENSE).

In plain terms:

- **Free for personal use, always.** Use it, modify it, trade your own capital
  with it, at no cost.
- **If you run a modified version as a network service**, AGPL requires you to
  make your source available to its users.
- **Commercial licence available.** If AGPL terms don't work for your
  organisation — for example, embedding this in a proprietary or white-labelled
  product — a separate commercial licence can be arranged. See below.

*(This summary is for convenience only; the LICENSE file governs.)*

---

## Commercial licensing and support

Available directly from the author:

- Commercial licences for proprietary or white-label deployment
- Custom strategy and broker adapter development
- Support retainers, including broker API change management

📧 **doosasreenivas@gmail.com**

---

## Author

Built and maintained by **Sreenivas Doosa**.

Copyright © 2026 Sreenivas Doosa. All rights reserved.
