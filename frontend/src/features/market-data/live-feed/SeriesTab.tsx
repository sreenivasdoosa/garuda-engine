/**
 * One derived series: the live value per underlying, and its chart on demand.
 *
 * The four tabs -- straddle, implied volatility, put-call ratio, synthetic
 * future -- differ only in which series they read and what the numbers mean,
 * so they are one component parameterised rather than four near-copies.
 *
 * **The chart opens in a drawer, not inline.** A chart squeezed into a card
 * grid is too small to read a minute bar on, and every underlying having one
 * means every underlying redrawing on every tick. One at a time, full width,
 * over the cards it is being compared against.
 *
 * **It is the same chart the indices use**, not a smaller one of its own. A
 * derived series is served by the same history route under its own instrument
 * id (`SYNTH:STRADDLE-NIFTY`), so the interval buttons, the line-versus-candle
 * toggle, the zoom and the panning all come for free -- and there is one chart
 * to fix rather than two that drift.
 *
 * **The live value and the chart come from different places, deliberately.**
 * The number on a card is the last tick, straight off the socket. The chart is
 * closed one-minute bars from the engine's own tables, plus the minute still
 * forming -- which is the part a trader is actually watching.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BsGraphUp } from 'react-icons/bs';
import BottomSlidePanel from '@/components/common/BottomSlidePanel';
import CandlestickChart from '@/components/common/CandlestickChart';
import { mdIndicesApi, wallClockEpochMs } from '@/api/marketDataApi';
import { useMarketData, type LiveTick, type SeriesKind } from '@/context/MarketDataContext';

/** The code the engine puts in an instrument id: `SYNTH:<code>-<symbol>`. */
const SERIES_CODE: Record<SeriesKind, string> = {
  STRADDLE: 'STRADDLE',
  PCR: 'PCR',
  IV: 'IV',
  IVSKEW: 'IVSKEW',
  SYNFUT: 'SYNFUT',
};

export interface SeriesTabProps {
  kind: SeriesKind;
  /** What the number is, for the axis and the empty state. */
  label: string;
  /** How many decimals the value is worth showing. */
  precision?: number;
  /** Appended to the value on a card. */
  unit?: string;
  /** Whether the chart offers the spot and near-month future to compare
   *  against. Only the synthetic future is read that way: it exists to be
   *  measured against the two things it sits between. */
  comparable?: boolean;
}

function value(tick: LiveTick | undefined, precision: number, unit: string) {
  if (!tick) return <span className="text-ink-faint font-mono">—</span>;
  return (
    <span className="font-mono tabular-nums">
      {tick.lastPrice.toFixed(precision)}
      {unit}
    </span>
  );
}

export default function SeriesTab({
  kind,
  label,
  precision = 2,
  unit = '',
  comparable = false,
}: SeriesTabProps) {
  const { seriesFor } = useMarketData();
  const live = seriesFor(kind);
  const { data } = useQuery({
    queryKey: ['market-data', 'indices'],
    queryFn: () => mdIndicesApi.getAll(),
    staleTime: 5 * 60 * 1000,
  });
  const [charting, setCharting] = useState<string | null>(null);

  const indices = data?.indices ?? [];
  if (indices.length === 0) {
    return <p className="text-ink-soft">No index is curated, so there is no {label} to show.</p>;
  }

  const open = indices.find((index) => index.symbol === charting);

  return (
    <>
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
        {indices.map((index) => {
          const tick = live.get(index.symbol);
          return (
            <div
              key={index.symbol}
              className="rounded-control border border-hairline bg-card p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-1 font-semibold">
                  {index.symbol}
                  <button
                    type="button"
                    onClick={() => setCharting(index.symbol)}
                    title={`Chart ${index.symbol} ${label}`}
                    aria-label={`Chart ${index.symbol} ${label}`}
                    className="text-ink-faint hover:text-primary-500 transition-colors"
                  >
                    <BsGraphUp />
                  </button>
                </span>
                <span className="text-xs text-ink-faint">{label}</span>
              </div>
              <div className="mt-1 text-xl">{value(tick, precision, unit)}</div>
              {!tick && (
                <p className="mt-1 text-xs text-ink-faint">
                  not enabled, or waiting for the chain
                </p>
              )}
            </div>
          );
        })}
      </div>

      <BottomSlidePanel
        isOpen={charting !== null}
        onClose={() => setCharting(null)}
        title={`${charting ?? ''} ${label}`}
        subtitle={open?.exchange}
        height="75vh"
      >
        {charting && (
          <CandlestickChart
            // The series' own instrument id. The history route reads it and
            // serves from the engine's tables instead of from the broker.
            symbol={`SYNTH:${SERIES_CODE[kind]}-${charting}`}
            interval="minute"
            height={470}
            liveTick={
              live.get(charting)
                ? {
                    price: live.get(charting)!.lastPrice,
                    timestamp: wallClockEpochMs(live.get(charting)!.timestamp),
                  }
                : undefined
            }
            spotSymbol={
              comparable && open?.hasSpot ? (open.fullSpotSymbol ?? undefined) : undefined
            }
            futuresSymbol={comparable ? (open?.fullFuturesSymbol ?? undefined) : undefined}
          />
        )}
      </BottomSlidePanel>
    </>
  );
}
