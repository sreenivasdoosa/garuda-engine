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
- Paper-mode and backtest results do not predict live performance. Slippage, latency,
  partial fills, and broker outages are real and will differ from simulation.
- **You are solely responsible for every order this software places on your
  behalf**, including orders resulting from bugs, misconfiguration, or
  unexpected market conditions.
- Run in paper mode until you fully understand the behaviour. Start small.

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

- **No bundled historical data**, and backtesting is off by default — see
  [Backtesting](#backtesting).
- Not an HFT or latency-arbitrage system. The target is systematic trading at
  seconds-to-minutes granularity, not microseconds.
- No custody and no order matching — this is not a broker.
- No strategy recommendations shipped in core.
- No multi-tenant account management, RBAC, or compliance reporting.

---

## Backtesting

Supported, but **opt-in and unbundled**. The engine ships no historical data and
no data loader of its own. Point Garuda at a history source you trust, enable
backtesting, and your data replays through the *same* evaluator, sizer and risk
gate that run live, routed to the paper broker.

It is off by default, and that is deliberate. Historical market data for Indian
markets is worse than it looks:

- **Options history is largely unavailable.** Complete strike-and-expiry chains
  barely exist for earlier years, and what exists is partial.
- **Intraday OHLC is unreliable.** Broker candle APIs reconstruct bars from
  periodic snapshots rather than true tick aggregation, so intraday highs and
  lows are frequently wrong — precisely the values a stop-loss or breakout
  strategy depends on.
- **Vendor archives are inconsistent** in format, symbology and field semantics,
  requiring a repair pipeline that is itself a source of silent error.

A backtester built on this data does not fail loudly. It produces confident,
specific, wrong numbers — and those get traded with real capital. So Garuda will
not hand you data and imply it is sound. Bring your own, and the results carry
the caveats where you can see them.

**Paper mode against a live feed** (below) remains the recommended way to
validate a strategy, because it is the only one that shows you real spreads,
real liquidity and real feed interruptions.

Deterministic replay of the engine's own journal also exists, but that is test
infrastructure for proving the engine behaves identically across changes — not a
strategy research tool.

---

## Paper mode

The supported way to validate a strategy before committing capital. Paper is a
property of a *subscription*, not of the system — the same strategy can run
paper on one account and live on another, at the same time, off the same
signals:

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
headline return figure. Run at least one full expiry cycle in paper mode before
any live deployment.

---

## Installing

Garuda is a **server application**, not a library. You install it, it runs, and
you drive it from the Console in your browser. Three ways to get it:

**Installer script — recommended.** Sets up PostgreSQL, the service, migrations
and seed data in one go.

```bash
# Linux
sudo ./scripts/linux/install.sh

# Windows (elevated PowerShell)
.\scripts\windows\install.ps1
```

**Docker.**

```bash
docker compose -f scripts/docker/compose.yaml up -d
```

**pip**, if you already live in Python. This installs the `garuda` command, not
an importable API:

```bash
pip install garuda-engine
garuda init      # config, migrations, seed data, admin password
garuda serve     # engine + Console on http://localhost:8080
```

---

## First run

1. Open the Console and sign in as `admin`. Change the password.
2. **Add a trading client** — a display name, a broker, and your client id.
   One row per broker account; add as many as you run.
3. **Log in to the broker.** Click *Login* on the client and complete the
   broker's OAuth flow. Nothing is automated: Garuda never stores credentials
   for unattended login, and an expired session halts trading rather than
   quietly renewing itself.
4. **Create a strategy definition** — pick a template, an underlying, a trigger,
   and its configuration. Strategies are configured here, not written in Python.
5. **Subscribe the strategy to a client**, choosing **paper** or **live** and the
   capital to allocate. The same strategy can be paper on one account and live
   on another at the same time, driven by the same signals.
6. **Watch the Terminal.** Positions, P&L, fills and risk breaches arrive live.

Start in paper. Run at least one full expiry cycle before you allocate real
capital to anything.

Full walkthrough: [docs/getting-started.md](docs/getting-started.md)

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Console + Terminal      configure, operate, watch        │
├──────────────────────────────────────────────────────────┤
│  Strategy layer          evaluators · templates · config  │
├──────────────────────────────────────────────────────────┤
│  Engine core             venue-neutral, no I/O            │
│    Dispatcher · Sizer · RiskGate · OrderManager · Journal │
├──────────────────────────────────────────────────────────┤
│  Domain model            Money · Instrument · Exchange    │
├──────────────────────────────────────────────────────────┤
│  Adapter layer           brokers · feeds · persistence    │
└──────────────────────────────────────────────────────────┘
```

Dependencies point downward only. The core imports no adapter.

These protocols form the public contract; changing them is a breaking release:

| Interface | Purpose | Implement it when |
|---|---|---|
| `BrokerAdapter` | Auth, orders, positions, market data, instrument master | Adding a new broker |
| `StrategyEvaluator` | Receives market events and position state, emits intents | Adding entry logic no template covers |
| `MarketDataFeed` | Ticks, quotes, instruments, history | Adding a data provider |
| `EventBus` / `Store` | Transport and persistence | Changing deployment shape |
| `Clock` | Time, abstracted for deterministic replay | Almost never — it is test infrastructure |

Evaluators never talk to a broker. They emit intents; the engine sizes them,
risk-gates them and routes them — to a real broker or the paper broker, per
subscription. Adapters never contain strategy logic. Keeping that boundary is
what makes upgrades painless and lets one strategy run paper and live at once.

Deeper detail: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Extending without forking

Extensions ship as separate pip packages and are discovered at runtime via entry
points. You never modify this repository to add your own:

```toml
[project.entry-points."garuda.brokers"]
mybroker = "my_package.broker:MyBrokerAdapter"

[project.entry-points."garuda.evaluators"]
my_logic = "my_package.evaluator:MyEvaluator"
```

Five extension points, all registries:

| Entry point | What you add |
|---|---|
| `garuda.brokers` | A broker adapter — auth, orders, positions, market data |
| `garuda.feeds` | A market data provider |
| `garuda.evaluators` | Custom entry logic, which then appears as a template in the Console |
| `garuda.indicators` | An indicator the rule engine can reference |
| `garuda.resolvers` | A direction provider or instrument resolver |

Strategies themselves are **configuration, not code** — a template, an
underlying, a trigger and its parameters, created in the Console and stored in
the database. Writing Python is for the case where no existing template can
express your logic.

Core carries the paper broker and a reference adapter only. Every other adapter
lives in its own repo with its own tests, so a broker API change breaks one
package rather than the release. A new adapter is correct when it passes the
contract test suite — no broker access needed to review one.

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
| 0 | Foundations — layout, lint and type guardrails, domain model, property tests |
| 1 | Vertical slice — one broker, paper mode, one strategy, end to end with the UI, journal replay proving determinism |
| 2 | Market data — remaining feeds, provider failover, history, option chain, synthetic instruments |
| 3 | Strategy engine — template hierarchy, config resolution, indicators, tranches, breakout, hedging |
| 4 | Live execution — full order lifecycle, reconciliation, exits, trailing stops, complete risk gate |
| 5 | Remaining brokers, each written against the adapter contract suite |
| 6 | Equity and MTF — universes, sizing, funding, corporate actions |
| 7 | Multi-leg and combo strategies |
| 8 | Capital, charges, reports and analytics |
| 9 | Packaging — Linux and Windows installers, Docker, backups, operations |
| 10 | Opt-in backtesting against a history source you supply |

Phase 1 is thin but touches every seam; nothing after it ships until those seams are
proven clean. Full detail in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

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
