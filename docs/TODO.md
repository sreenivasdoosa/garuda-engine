# To do

Work that is decided but deliberately not started. Each item says what
it is, why it waits, and what unblocks it. When one lands, delete it
here and log it in `PROGRESS.md` in the same change. The ordered list of
what comes next in general is the **Next** section of `PROGRESS.md`;
this file holds only the items parked by an explicit decision.

## Console pages

- [ ] **System Config.** The reference's page over its `SYSTEM_CONFIG`
  table. Not served because nothing in the engine reads a setting from
  such a table yet -- every threshold and offset lives on the row it
  belongs to (exchange, broker config, RMS config). Build it the first
  time a setting needs a home of its own, and build the row and its
  reader in the same change as the page. Decided 2026-10-11.

- [ ] **Corporate Actions.** Splits, bonuses and dividends adjusting
  equity positions and candle history. Waits for the equity phase of
  the plan (`IMPLEMENTATION_PLAN.md`), since only equity positions are
  affected and there is no equity strategy running yet. Read the
  reference's table in the schema dump before designing it. Decided
  2026-10-11.

## Strategy engine

- [ ] **External signals.** The `EXTERNAL_SIGNAL` event type and dispatcher
  branch exist from step 2 of `STRATEGY_ENGINE.md` §10 with no producer.
  When needed: an API endpoint and in-process conditions posting the
  reference's `ENTRY` and `EXIT` signals with tranche selection, the
  two-second batching, the gap check, and `EXT_SIGNAL_EXIT` square-off.
  `signal_trigger_enabled` is stored and refused when set until then.
  Decided 2026-10-15.
