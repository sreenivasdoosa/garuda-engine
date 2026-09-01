/**
 * HeaderIndexTicker — single compact tick card sized to fit in the app header.
 *
 * Rendering rules:
 *   - Whole card is clickable → opens the chart panel.
 *   - On hover, an inline chart icon fades in (mirrors screener's UX).
 *   - Live green dot when WS is connected AND this symbol has ticked this session.
 *   - Color of price + change + % is green/red based on sign of change.
 *   - Designed to live in a 40-48px tall header; component height is 32px.
 */
import React from 'react';
import { BsGraphUp } from 'react-icons/bs';
import './HeaderIndexTicker.css';

interface Props {
  label: string;
  lastPrice: number;
  change: number;
  changePct: number;
  isLive: boolean;
  onChartClick: () => void;
}

const fmtPrice = (n: number): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtChange = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
const fmtPct = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

export const HeaderIndexTicker: React.FC<Props> = ({
  label,
  lastPrice,
  change,
  changePct,
  isLive,
  onChartClick,
}) => {
  const positive = change >= 0;

  return (
    <div
      className={`header-index-ticker ${positive ? 'pos' : 'neg'}`}
      onClick={onChartClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onChartClick();
        }
      }}
      title={`${label} — click to view chart`}
    >
      <span className="hit-label">{label}</span>
      <span className="hit-price">{fmtPrice(lastPrice)}</span>
      <span className="hit-change">{fmtChange(change)}</span>
      <span className="hit-pct">({fmtPct(changePct)})</span>
      <button
        type="button"
        className="hit-chart-btn"
        onClick={(e) => {
          e.stopPropagation();
          onChartClick();
        }}
        title="View chart"
        aria-label={`View ${label} chart`}
      >
        <BsGraphUp size={12} />
      </button>
      {isLive && <span className="hit-live-dot" title="Live" aria-label="live" />}
    </div>
  );
};

export default HeaderIndexTicker;
