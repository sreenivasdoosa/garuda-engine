import React from 'react';

import type { ComboLegSpec, ComboSpec } from '@/types/strategy-engine';

import HelpIcon from '@/components/common/HelpIcon';
import { strategyDefinitionHelpContent } from '@/data/help/strategy-definition-help';

/**
 * Editor for a strategy's declared combo shape (`comboSpecJson`).
 *
 * A definition's product, tradeMode and direction are single-valued, and that is the ceiling a
 * combo hits: a long/short pair holds cash equity as CASHBUY and its futures leg as INTRADAY, in
 * opposite directions, inside one strategy. This declares that disagreement per leg.
 *
 * Absent by default. A strategy with no spec behaves exactly as it always has — the shape comes
 * from its trade mode — so turning the toggle off is a real "this is not a combo", not a blank
 * combo.
 *
 * The value travels as a JSON string because that is how every other structured strategy field
 * travels (directionProviderParams, the rules JSON). Parsing is defensive: a spec the UI cannot
 * read is shown as raw JSON rather than silently replaced, because overwriting a spec somebody
 * hand-wrote through the API would lose their work with no warning.
 */
interface Props {
  value?: string;
  onChange: (next: string | undefined) => void;
  disabled?: boolean;
}

const label = 'mb-1 block text-sm font-medium text-ink';
const ctrl = 'h-9 w-full rounded border border-hairline bg-card px-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-50';
const help = 'mt-1 block text-xs text-ink-soft';

/**
 * The C1 shape: short the future, long the cash.
 *
 * Sequence is left unset so the engine applies its own rule — the derivative leg goes first,
 * because the futures fill is the uncertain one and committing the cash leg before it fills is
 * what leaves the book one-sided. Setting it here would freeze a copy of that reasoning in data.
 */
const defaultLongShort = (): ComboSpec => ({
  type: 'LONG_SHORT',
  legs: [
    { role: 'SHORT_LEG', instrument: 'FUTURE', direction: 'SHORT', product: 'INTRADAY' },
    { role: 'LONG_LEG', instrument: 'EQUITY', direction: 'LONG', product: 'CASHBUY' },
  ],
});

/**
 * The M7a shape: a futures position protected by a bought option.
 *
 * The option leg carries no strike and no CE/PE — both derive. Its strike comes from the
 * strategy's hedge-distance fields (the same ones hedged option selling uses), and its type
 * follows the futures direction: protection for a SHORT future is a CE above spot, for a LONG
 * future a PE below.
 */
const defaultFuturesOptions = (): ComboSpec => ({
  type: 'FUTURES_OPTIONS',
  legs: [
    { role: 'SHORT_LEG', instrument: 'FUTURE', direction: 'SHORT' },
    { role: 'HEDGE', instrument: 'OPTION', direction: 'LONG' },
  ],
});

/** Long stock + a SOLD call — both MAIN legs (the stock covers the call, it does not protect it). */
const defaultCoveredCall = (): ComboSpec => ({
  type: 'COVERED_CALL',
  legs: [
    { role: 'LONG_LEG', instrument: 'EQUITY', direction: 'LONG', product: 'CASHBUY' },
    { role: 'SHORT_LEG', instrument: 'OPTION', direction: 'SHORT', product: 'INTRADAY' },
  ],
});

/** Long stock + a BOUGHT put with role HEDGE — strike from hedge distance, exits after the stock. */
const defaultProtectivePut = (): ComboSpec => ({
  type: 'PROTECTIVE_PUT',
  legs: [
    { role: 'LONG_LEG', instrument: 'EQUITY', direction: 'LONG', product: 'CASHBUY' },
    { role: 'HEDGE', instrument: 'OPTION', direction: 'LONG', product: 'INTRADAY' },
  ],
});

export const defaultsByType: Record<ComboSpec['type'], () => ComboSpec> = {
  LONG_SHORT: defaultLongShort,
  FUTURES_OPTIONS: defaultFuturesOptions,
  COVERED_CALL: defaultCoveredCall,
  PROTECTIVE_PUT: defaultProtectivePut,
};

/**
 * The shape catalogue the form presents as "what the strategy trades" — the combo type takes the
 * Trade Mode position in the modal, so these labels are what the admin reads as the trade mode.
 * `storedTradeMode` is the mechanical enum value persisted underneath: the engine routes combos by
 * the spec (never by mode), but the stored mode still drives form plumbing — FUTURES hides Expiry
 * Type (no option leg), FUTURES_OPTIONS keeps it visible (an option leg needs an expiry).
 */
export const COMBO_SHAPES: { value: ComboSpec['type']; label: string; storedTradeMode: string; hint: string }[] = [
  { value: 'LONG_SHORT', label: 'Long Equity + Short Futures', storedTradeMode: 'FUTURES',
    hint: 'Shorts the future and holds the cash equity of the same underlying. No option leg.' },
  { value: 'FUTURES_OPTIONS', label: 'Futures + Options', storedTradeMode: 'FUTURES_OPTIONS',
    hint: 'A futures position protected by a bought option. CE/PE follows the futures direction; strike comes from the hedge-distance settings.' },
  { value: 'COVERED_CALL', label: 'Covered Call (Long Equity + Short Call)', storedTradeMode: 'FUTURES_OPTIONS',
    hint: 'Long stock with a sold call for income. The call\u2019s strike comes from the tranch strike settings (it is a MAIN leg); the stock is bought first \u2014 selling the call before holding stock is a naked short.' },
  { value: 'PROTECTIVE_PUT', label: 'Protective Put (Long Equity + Long Put)', storedTradeMode: 'FUTURES_OPTIONS',
    hint: 'Long stock with a bought put as protection. The put\u2019s strike comes from the hedge-distance settings and it exits after the stock.' },
];

const parse = (raw?: string): { spec?: ComboSpec; unreadable?: string } => {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as ComboSpec;
    if (!parsed || !Array.isArray(parsed.legs)) return { unreadable: raw };
    return { spec: parsed };
  } catch {
    return { unreadable: raw };
  }
};

const ComboSpecEditor: React.FC<Props> = ({ value, onChange, disabled }) => {
  const { spec, unreadable } = parse(value);
  const enabled = Boolean(spec || unreadable);

  const emit = (next: ComboSpec) => onChange(JSON.stringify(next));

  const setLeg = (index: number, patch: Partial<ComboLegSpec>) => {
    if (!spec) return;
    const legs = spec.legs.map((l, i) => (i === index ? { ...l, ...patch } : l));
    emit({ ...spec, legs });
  };

  return (
    <div className="mb-4 rounded border border-hairline p-3">
      <label className="flex items-center gap-2 text-sm font-medium text-ink">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? JSON.stringify(defaultLongShort()) : undefined)}
        />
        Multi-leg combo <HelpIcon article={strategyDefinitionHelpContent['strategyDef.comboSpec']} />
      </label>
      <span className={help}>
        Declares this strategy&apos;s legs explicitly. Leave off for a normal strategy — the shape
        then comes from Trade Mode, exactly as before.
      </span>

      {unreadable && (
        <div className="mt-3">
          <label className={label}>Combo spec (raw)</label>
          <textarea
            className="min-h-24 w-full rounded border border-hairline bg-card p-2 font-mono text-xs text-ink"
            value={unreadable}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value || undefined)}
          />
          <span className={help}>
            This spec could not be read as a combo, so it is shown as-is rather than replaced. Fix
            the JSON, or clear the checkbox to remove it.
          </span>
        </div>
      )}

      {spec && (
        <>
          <div className="mt-3">
            <label className={label}>Combo Type</label>
            <select
              className={ctrl}
              value={spec.type}
              disabled={disabled}
              onChange={(e) => {
                const nextType = e.target.value as ComboSpec['type'];
                // Switching type replaces the legs with that shape's template — the previous
                // shape's legs are meaningless under the new type and would just fail validation.
                emit(defaultsByType[nextType]());
              }}
            >
              {COMBO_SHAPES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <span className={help}>
              {COMBO_SHAPES.find((s) => s.value === spec.type)?.hint}
            </span>
          </div>

          {spec.legs.map((leg, i) => (
            <div key={i} className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-5">
              <div>
                <label className={label}>Leg {i + 1} Role</label>
                <select className={ctrl} value={leg.role} disabled={disabled}
                  onChange={(e) => setLeg(i, { role: e.target.value as ComboLegSpec['role'] })}>
                  <option value="LONG_LEG">LONG_LEG</option>
                  <option value="SHORT_LEG">SHORT_LEG</option>
                  <option value="PRIMARY">PRIMARY</option>
                  <option value="HEDGE">HEDGE</option>
                </select>
              </div>
              <div>
                <label className={label}>Instrument</label>
                <select className={ctrl} value={leg.instrument} disabled={disabled}
                  onChange={(e) => setLeg(i, { instrument: e.target.value as ComboLegSpec['instrument'] })}>
                  <option value="FUTURE">FUTURE</option>
                  <option value="EQUITY">EQUITY (cash)</option>
                  {/* OPTION only where a shape can supply its strike: hedge legs derive from hedge
                      distance, a covered call's sold call from the tranch strike settings. In
                      LONG_SHORT the server rejects it (TC-49-0047). */}
                  {spec.type !== 'LONG_SHORT' && <option value="OPTION">OPTION</option>}
                </select>
                {leg.instrument === 'OPTION' && (
                  <span className={help}>
                    {leg.role === 'HEDGE'
                      ? 'CE/PE and strike derive: type from the protected leg\u2019s direction, strike from the strategy\u2019s hedge distance.'
                      : 'A MAIN option leg: CE for a covered call; strike comes from the tranch strike settings (MoneyNess ATM/OTM\u00b1n).'}
                  </span>
                )}
              </div>
              <div>
                <label className={label}>Direction</label>
                <select className={ctrl} value={leg.direction} disabled={disabled}
                  onChange={(e) => setLeg(i, { direction: e.target.value as ComboLegSpec['direction'] })}>
                  <option value="LONG">LONG</option>
                  <option value="SHORT">SHORT</option>
                </select>
              </div>
              <div>
                <label className={label}>Product</label>
                <select className={ctrl} value={leg.product ?? ''} disabled={disabled}
                  onChange={(e) => setLeg(i, { product: e.target.value || undefined })}>
                  <option value="">Inherit strategy</option>
                  <option value="INTRADAY">INTRADAY</option>
                  <option value="POSITIONAL">POSITIONAL</option>
                  <option value="CASHBUY">CASHBUY</option>
                  <option value="MTF">MTF</option>
                </select>
              </div>
              <div>
                <label className={label}>Qty Ratio</label>
                <input
                  type="number" min={0} step="0.01" className={ctrl}
                  value={leg.quantityRatio ?? ''}
                  disabled={disabled}
                  placeholder="1"
                  onChange={(e) => setLeg(i, {
                    quantityRatio: e.target.value === '' ? undefined : Number(e.target.value),
                  })}
                />
              </div>
            </div>
          ))}

          <span className={help}>
            Sizing stays one decision for the whole structure; the ratio only distributes it. Blank
            means this leg takes the full size — which is what a 1:1 cash-against-futures pair
            wants, since a leg&apos;s quantity is already in its own units.
          </span>
        </>
      )}
    </div>
  );
};

export default ComboSpecEditor;
