/**
 * HedgeDistanceBadge — small inline display for the "Pos Hedges" column in
 * the admin terminal. Shows two badges side-by-side:
 *
 *   I-{n}   amber — trades currently hedged at the strategy's INTRADAY distance
 *   P-{m}   primary — trades currently hedged at the strategy's POSITIONAL distance
 *
 * Applies only to active POSITIONAL SHORT trades that have a hedge. Renders
 * nothing when both counters are zero. Tailwind design system.
 */
import React from 'react';

interface Props {
  intradayCount: number;
  positionalCount: number;
}

const cellStyle: React.CSSProperties = {
  display: 'inline-flex',
  gap: 4,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
};

const badge = 'inline-flex items-center rounded px-1.5 py-0.5 text-[0.7rem] font-semibold';

export const HedgeDistanceBadge: React.FC<Props> = ({ intradayCount, positionalCount }) => {
  if (!intradayCount && !positionalCount) {
    return <span className="text-ink-faint">—</span>;
  }
  return (
    <span style={cellStyle} title="Positional short trades by current hedge distance">
      {intradayCount > 0 && (
        <span className={`${badge} bg-warning-400 text-black`} title="Intraday-distance hedges">
          I-{intradayCount}
        </span>
      )}
      {positionalCount > 0 && (
        // Fixed blue (not the flavor primary): white-on-primary-500 is unreadable
        // on light-primary brands (pro amber, lab green); blue reads on all 7.
        <span className={`${badge} bg-blue-600 text-white`} title="Positional-distance hedges">
          P-{positionalCount}
        </span>
      )}
    </span>
  );
};

export default HedgeDistanceBadge;
