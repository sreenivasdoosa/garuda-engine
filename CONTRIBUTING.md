# Contributing to Garuda Engine

Contributions are welcome — especially broker adapters, market data feeds, tests
and documentation.

Be aware that the project is early. Interfaces move without notice before v1.0,
and outside contribution only becomes practical once the adapter contract suite
lands (Phase 5 in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)).
Open an issue before starting anything large.

---

## Before your first pull request

Please sign the [Contributor License Agreement](CLA.md). This is required. It
lets the project be offered under a commercial licence alongside the AGPL, which
is what funds continued maintenance. Without it, contributions cannot be merged.

---

## Use of AI assistants

**AI assistance is allowed and does not need special permission.** It does need
disclosure, and it does not change who is responsible for the result.

The repository carries an [AGENTS.md](AGENTS.md) with the project's hard rules
and pointers to the design documents. Claude Code reads it via the `CLAUDE.md`
symlink; Codex and other agents read it by name. **Point your agent at it before
it touches anything** — the rules below are the ones it will otherwise break.

### Disclose it with a trailer

Add an `Assisted-by:` trailer to any commit where an AI agent wrote or
substantially shaped the change:

```
Assisted-by: Claude Opus 5 [Claude Code]
Assisted-by: <agent name>:<model version> [<tool>]
```

Do **not** use `Co-authored-by:` for an AI agent. A model cannot sign the CLA,
cannot hold copyright and cannot bear responsibility for what it produced.
Listing one as a co-author muddies the chain of title that both the AGPL and the
commercial licence depend on, and it is inconsistent with copyright-office
guidance that an AI tool or its provider should not be named as an author merely
because it was used.

If you use `Generated-by:` as well, keep `Assisted-by:` alongside it.

### Never let an agent sign off

`Signed-off-by:` certifies the Developer Certificate of Origin. Only a human can
certify that they had the right to submit a contribution. An AI agent must never
add that tag, and you must never add it on an agent's behalf without having
reviewed the change yourself.

### You are responsible either way

The human submitting the pull request is fully responsible for correctness,
licensing and fitness of every line in it, regardless of what produced them.
"The model wrote it" is not a defence, and it is not a review.

### Money paths get stricter review

Changes to order execution, position state, P&L arithmetic or the risk gate are
reviewed strictly and require accompanying behavioural tests. AI-assisted changes
in those areas get more scrutiny, not less, and may take longer to merge. Bugs
there cost real money. That is deliberate.

---

## Standards

The rules below are enforced in CI, not by reviewer patience. All of them exist
because of a specific failure mode; see [AGENTS.md](AGENTS.md) for the reasoning.

1. **`Decimal` only** in money and price paths. `float` there fails the build.
   Database columns are `NUMERIC`, never `double precision`.
2. **No `datetime.now()` or `asyncio.sleep()`** outside the clock abstraction.
   Recorded journals must replay deterministically.
3. **Behavioural tests only.** Never read production source and assert on its
   text. Assert on what the engine produced — emitted intents, order requests,
   journal events, resulting positions, P&L.
4. **Fail closed.** Unknown order state, stale price, lost connection or a
   reconciliation mismatch means halt and alert. Never guess in a money path.
5. **Layer dependencies point downward only**, enforced by import-linter.
6. Type checking is `mypy --strict`. Formatting and linting are `ruff`.

New broker adapters must pass the contract test suite unmodified. That suite is
what lets a reviewer accept an adapter for a broker they have no account with.

---

## Pull requests

- One logical change per pull request.
- Explain *why*, not just what. A commit message that only restates the diff
  tells a future reader nothing they could not already see.
- Include tests. A change to engine behaviour without a behavioural test will be
  asked for one.
- Make sure CI is green before asking for review.

---

## Reporting a security issue

Do not open a public issue for a security vulnerability. Email
**doosasreenivas@gmail.com** with the details and allow reasonable time for a
fix before disclosing.
