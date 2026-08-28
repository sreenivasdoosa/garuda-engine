# Garuda Engine — working notes for coding agents

Read this first, every session. It is the durable context; the design documents
below are the detail.

`CLAUDE.md` is a symlink to this file, so Claude Code and Codex read the same
instructions. Edit this file, never the symlink.

## What this is

A self-hosted, event-driven algorithmic trading engine in Python. One operator
runs it on their own machine or cloud box, signs in as `admin`, and manages a
handful of **trading clients** — broker accounts belonging to them or their
family. Equities, futures, options, MTF and multi-leg combos, across NSE, BSE
and MCX today, with a venue model built for other exchanges and timezones.

It is a rewrite of a mature private Java engine. Refer to that system only as
**"the reference engine"** — never by its product or company name, in code,
config, docs, database identifiers, log strings, CSS classes or commit
messages. This is a hard rule with no exceptions.

It is a **server application, not a library.** Strategies are configuration
rows created in the Console, not user Python classes. `pip install
garuda-engine` installs the `garuda` command, not an importable API.

## Authoritative documents

Read the relevant one before proposing anything. They win over your priors.

| Document | Question it answers |
|---|---|
| `docs/SCOPE_DECISIONS.md` | Is this feature in or out, and why |
| `docs/DESIGN.md` | How is it built |
| `docs/IMPLEMENTATION_PLAN.md` | What phase are we in, what comes next |
| `ARCHITECTURE.md` | The principles the design holds to |

`docs/JAVA_FEATURE_INVENTORY.md` maps the reference engine's internals. It is
gitignored on purpose — never commit it, never quote it into a tracked file.

## Rules that do not bend

1. **`Decimal` only** in any money or price path. A `float` there is a defect,
   and CI fails on it. Postgres columns are `NUMERIC`, never `double precision`.
2. **No `datetime.now()` or `asyncio.sleep()`** outside `core/clock.py`.
   Everything goes through the `Clock` protocol, which is what makes recorded
   journals replay deterministically.
3. **Behavioural tests only.** Never read production source and assert on its
   text. Assert on what the engine produced: emitted intents, order requests,
   journal events, resulting positions, P&L. The reference engine accumulated
   447 source-text pins that caught zero defects across two refactors.
4. **Fail closed.** Unknown order state, stale price, lost connection,
   reconciliation mismatch — halt and alert. Never guess in a money path, never
   auto-correct silently.
5. **Layer dependencies point downward only**, enforced by import-linter.
   `domain/` imports nothing but `domain/`. The core imports `protocols/`, never
   a concrete broker or feed.
6. **The journal and the row mutation share one transaction.** They cannot be
   allowed to diverge.

## Shape of the system

- **Single admin login.** No roles, no permissions matrix, no tenancy.
- **Trading client** = display name + broker + client id. `(broker, client_id)`
  is unique. This replaces the reference engine's user/broker pair.
- **Paper is a property of a subscription**, not of the system. The same
  strategy runs paper on one account and live on another, simultaneously, off
  the same signals.
- **Broker login is operator-initiated only.** No auto-login, no TOTP
  automation, no stored credentials for unattended use. An expired session
  halts trading for that client and never self-heals.
- **PostgreSQL only.** No SQLite, not even for dev.
- **Market data runs in-process.** There is no separate data service.

## Deliberately absent

Billing · licensing · email of any kind · Telegram · permissions · auto-login ·
mock trading · scanners · momentum scoring · AI assistant · signal export ·
external P&L tracking · S3 backup · partial profit booking · multi-tenancy ·
any optimization aimed at thousands of users.

Do not reintroduce these because the reference engine had them. Scope creep back
toward its full feature set is the named risk in the plan. Anything not in
`SCOPE_DECISIONS.md` needs an explicit decision from the owner first.

## Repository

Monorepo: `backend/` · `frontend/` · `scripts/` · `docs/`. Default branch is
`master`. Public, AGPL-3.0 with a commercial licence alongside.

The frontend is copied from the reference engine's React app and stripped in
passes, per phase — Console and Terminal only, no user portal. Keep API response
shapes close to what it already expects; that is what keeps the strip cheap.

## Commits

Disclose AI assistance with an `Assisted-by:` trailer, never `Co-authored-by:` —
a model cannot sign the CLA, hold copyright, or bear responsibility, and naming
one as co-author muddies the chain of title the dual licence depends on:

```
Assisted-by: Claude Opus 5 [Claude Code]
Assisted-by: <agent name>:<model version> [<tool>]
```

`.claude/settings.json` sets this trailer automatically under Claude Code. Any
other agent must add it itself. **Never
add `Signed-off-by:`** — that certifies the Developer Certificate of Origin, and
only a human can certify it. Full policy in `CONTRIBUTING.md`.

## Working style

- Small blocks first, connected one at a time. Every phase ends with a system
  that runs and tests that prove it — never a half-wired subsystem.
- Changes to order execution, position state and P&L arithmetic get reviewed
  strictly and need tests. Bugs there cost real money.
- Ask before adding a dependency, a table, or a feature that is not in the plan.
