import React from 'react';

import type { TradeMode } from '@/types/strategy-engine';
import { Toggle } from '@/components/ui';

/**
 * Editor for the N_BARS_BREAKOUT direction provider's params. Generic —
 * any strategy can use this provider; nothing here is template-specific
 * (no SL/Target, no DTE, no trading window — those live on the strategy
 * / tranch config level).
 *
 * Stored in directionProviderParams (Record<string, string>):
 *   timeframeMinutes, lookbackBars, onHighBreak, onLowBreak, maxReentries,
 *   alwaysInPosition.
 *
 * alwaysInPosition controls the post-SL / post-Target behaviour in the
 * ADAPTIVE_OPTIONS evaluator:
 *   - "false" / unset (default): wait for the next breakout candle to
 *     fire the re-entry; sit flat between exits.
 *   - "true": auto re-enter at the next candle close in the prior
 *     direction (or flip to the new signal if the new candle disagrees).
 *     Effective behaviour = stay continuously exposed until expiry /
 *     maxReentries.
 */
interface Props {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  tradeMode?: TradeMode;
  disabled?: boolean;
}

const setKey = (
  prev: Record<string, string>,
  key: string,
  v: string | undefined,
): Record<string, string> => {
  const next = { ...prev };
  if (v === undefined || v === '') {
    delete next[key];
  } else {
    next[key] = v;
  }
  return next;
};

// Show LONG / SHORT in the dropdown labelled with what the eventual trade
// action is for the strategy's TradeMode — keeps the choice unambiguous.
const directionLabel = (dir: 'LONG' | 'SHORT', tradeMode?: TradeMode): string => {
  if (tradeMode === 'OPTION_BUYING') {
    return dir === 'LONG' ? 'LONG (buy CE)' : 'SHORT (buy PE)';
  }
  // Default OPTION_SELLING
  return dir === 'LONG' ? 'LONG (sell PE — bullish)' : 'SHORT (sell CE — bearish)';
};

const label = 'mb-1 block text-sm font-medium text-ink';
const ctrl = 'h-9 w-full rounded border border-hairline bg-card px-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-50';
const help = 'mt-1 block text-xs text-ink-soft';

const NBarsBreakoutParamsEditor: React.FC<Props> = ({ value, onChange, tradeMode, disabled }) => {
  const set = (key: string, v: string | undefined) => onChange(setKey(value, key, v));

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="mb-3">
          <label className={label}>Candle Timeframe (min)</label>
          <select className={ctrl} value={value.timeframeMinutes ?? ''} disabled={disabled} onChange={(e) => set('timeframeMinutes', e.target.value || undefined)}>
            <option value="">Select…</option>
            <option value={1}>1</option>
            <option value={3}>3</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={15}>15</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
          <span className={help}>Aggregation timeframe for breakout candles.</span>
        </div>
        <div className="mb-3">
          <label className={label}>Lookback Bars (N)</label>
          <input type="number" min={1} className={ctrl} value={value.lookbackBars ?? ''} disabled={disabled} onChange={(e) => set('lookbackBars', e.target.value || undefined)} />
          <span className={help}>Bars whose high/low form the rolling window (excludes current).</span>
        </div>
        <div className="mb-3">
          <label className={label}>Max Re-entries / direction</label>
          <input type="number" min={1} max={15} step={1} className={ctrl} value={value.maxReentries ?? ''} disabled={disabled} onChange={(e) => set('maxReentries', e.target.value || undefined)} placeholder="1-15 (default 15)" />
          <span className={help}>
            Maximum re-entries per direction per run. Required range 1-15 (system cap). Leave blank to use the system default (15). The previous "0 = unlimited" option was retired (M14) because a persistently failing fireEntry produced an unbounded retry loop until the trading-window cutoff.
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="mb-3">
          <label className={label}>When close &gt; last N candles high → go</label>
          <select className={ctrl} value={value.onHighBreak ?? 'LONG'} disabled={disabled} onChange={(e) => set('onHighBreak', e.target.value || undefined)}>
            <option value="LONG">{directionLabel('LONG', tradeMode)}</option>
            <option value="SHORT">{directionLabel('SHORT', tradeMode)}</option>
          </select>
          <span className={help}>Trend-following: LONG. Mean-reversion: SHORT.</span>
        </div>
        <div className="mb-3">
          <label className={label}>When close &lt; last N candles low → go</label>
          <select className={ctrl} value={value.onLowBreak ?? 'SHORT'} disabled={disabled} onChange={(e) => set('onLowBreak', e.target.value || undefined)}>
            <option value="LONG">{directionLabel('LONG', tradeMode)}</option>
            <option value="SHORT">{directionLabel('SHORT', tradeMode)}</option>
          </select>
          <span className={help}>Trend-following: SHORT. Mean-reversion: LONG.</span>
        </div>
      </div>
      <div className="mb-3">
        <label htmlFor="np-always-in-position" className="flex cursor-pointer items-center gap-2">
          <Toggle
            id="np-always-in-position"
            checked={value.alwaysInPosition === 'true'}
            disabled={disabled}
            onChange={(checked) => set('alwaysInPosition', checked ? 'true' : undefined)}
          />
          <span className="text-sm font-medium text-ink">Always in position (auto re-entry after SL / Target)</span>
        </label>
        <span className={help}>
          OFF (default): after an SL or Target exit, wait for the next breakout candle to fire the re-entry. The run sits flat between exits.
          <br />
          ON: after an SL or Target exit, automatically re-enter at the next candle close in the prior direction (or flip if the new candle's signal disagrees). Effective behaviour — the run stays continuously exposed (CE or PE) until expiry or the Max Re-entries cap is hit. Every re-entry independently picks its strike / premium from the tranch config tree against the live spot at that moment, so ATM drifts naturally with the underlying.
        </span>
      </div>
    </div>
  );
};

export default NBarsBreakoutParamsEditor;
