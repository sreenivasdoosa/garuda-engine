/**
 * One card per curated index, updating on every tick.
 *
 * Which indices exist is the server's answer, not a list held here: the
 * Symbols page decides, and `/api/market-data/indices` reports each one along
 * with the instrument its price actually arrives under. Those differ -- NIFTY's
 * level is published as "NIFTY 50", and a commodity has no level at all, only
 * futures -- so the card keys off `fullSymbol` rather than reassembling it.
 *
 * A card with no tick yet says so. It does not show a zero: a zero is a price
 * a reader will believe.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BsGraphUp } from 'react-icons/bs';
import BottomSlidePanel from '@/components/common/BottomSlidePanel';
import CandlestickChart from '@/components/common/CandlestickChart';
import { mdIndicesApi, wallClockEpochMs } from '@/api/marketDataApi';
import { useMarketData, type LiveTick } from '@/context/MarketDataContext';

/**
 * Indian index levels span four orders of magnitude -- NIFTY near 25,000 and
 * MCX silver near 1,25,000 -- so a fixed two decimals overflows a card at the
 * top of that range and the open, high and low run into each other. Decimals
 * are dropped where they are noise: nobody reads silver to the paisa.
 */
function money(value: number): string {
  const big = Math.abs(value) >= 10_000;
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: big ? 0 : 2,
    maximumFractionDigits: big ? 0 : 2,
  });
}

function Price({ tick }: { tick: LiveTick | undefined }) {
  if (!tick) {
    return <div className="text-ink-faint text-lg font-mono">—</div>;
  }
  const up = (tick.change ?? 0) >= 0;
  return (
    <>
      <div className="text-xl font-mono font-semibold tabular-nums truncate">
        {money(tick.lastPrice)}
      </div>
      {tick.change !== null && (
        <div className={`text-sm font-mono ${up ? 'text-success-500' : 'text-danger'}`}>
          {up ? '▲' : '▼'} {Math.abs(tick.change).toFixed(2)}
          {tick.changePercent !== null && ` (${Math.abs(tick.changePercent).toFixed(2)}%)`}
        </div>
      )}
    </>
  );
}

function Range({ tick }: { tick: LiveTick | undefined }) {
  if (!tick || tick.open === null) return null;
  return (
    // min-w-0 on each cell is what actually stops the overlap: without it a
    // grid column refuses to shrink below its content and the three run
    // together.
    <dl className="mt-3 grid grid-cols-3 gap-2 text-[0.7rem] text-ink-soft">
      {(
        [
          ['Open', tick.open],
          ['High', tick.high],
          ['Low', tick.low],
        ] as [string, number | null][]
      ).map(([name, amount]) => (
        <div key={name} className="min-w-0">
          <dt className="text-ink-faint">{name}</dt>
          <dd className="font-mono tabular-nums truncate">
            {amount === null ? '—' : money(amount)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function IndexCards() {
  const { ticks } = useMarketData();
  // Which card's chart is open. One at a time: a grid of live charts is a
  // grid of redraws, and only one is ever being read.
  const [charting, setCharting] = useState<{ symbol: string; instrument: string } | null>(
    null,
  );
  const live = charting ? ticks.get(charting.instrument) : undefined;
  const { data, isLoading } = useQuery({
    queryKey: ['market-data', 'indices'],
    queryFn: () => mdIndicesApi.getAll(),
    // The curated set changes when an operator edits the Symbols page, which
    // is rare; the prices on top of it change every tick.
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return <p className="text-ink-soft">Loading indices…</p>;
  }

  const indices = data?.indices ?? [];
  if (indices.length === 0) {
    return (
      <p className="text-ink-soft">
        No index is curated. Mark a symbol as an index on the Symbols page and it appears here.
      </p>
    );
  }

  return (
    <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
      {indices.map((index) => {
        const tick = ticks.get(index.fullSymbol);
        return (
          <div
            key={`${index.exchange}:${index.symbol}`}
            className="rounded-control border border-hairline bg-card p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1 font-semibold">
                {index.symbol}
                <button
                  type="button"
                  onClick={() =>
                    setCharting({ symbol: index.symbol, instrument: index.fullSymbol })
                  }
                  title={`Chart ${index.symbol}`}
                  aria-label={`Chart ${index.symbol}`}
                  className="text-ink-faint hover:text-primary-500 transition-colors"
                >
                  <BsGraphUp />
                </button>
              </span>
              <span className="flex items-center gap-1 text-xs text-ink-faint">
                {/* MCX publishes no level for a commodity, so its price is the
                    current-month future. Worth saying on the card: the number
                    carries a basis the index ones do not. */}
                {index.isFutures && (
                  <span
                    className="rounded-control bg-raised px-1 text-[0.7rem] text-warning-400"
                    title={`priced from ${index.fullSymbol.split(':')[1]}`}
                  >
                    FUT
                  </span>
                )}
                {index.exchange}
              </span>
            </div>
            <div className="mt-2">
              <Price tick={tick} />
            </div>
            <Range tick={tick} />
            {!tick && (
              <p className="mt-2 text-xs text-ink-faint">
                waiting for {index.referenceSymbol}
              </p>
            )}
          </div>
        );
      })}

      {/* A drawer rather than a modal: a chart is wide and short, and the
          cards behind it stay readable while it is open -- which is the point,
          since the reason to open one is usually to compare it with them. */}
      <BottomSlidePanel
        isOpen={charting !== null}
        onClose={() => setCharting(null)}
        title={charting?.symbol ?? ''}
        subtitle={charting?.instrument}
        height="65vh"
      >
        {charting && (
          <CandlestickChart
            symbol={charting.instrument}
            interval="minute"
            height={420}
            // The forming candle, so the chart is current to the second rather
            // than to the minute.
            //
            // Wall-clock epoch, not the true one: the chart matches this
            // against the candle timestamps, which carry the same convention
            // because lightweight-charts renders its axis in UTC. A true
            // epoch lands five and a half hours behind every candle, matches
            // none of them, and the live price silently never appears.
            liveTick={
              live
                ? { price: live.lastPrice, timestamp: wallClockEpochMs(live.timestamp) }
                : undefined
            }
          />
        )}
      </BottomSlidePanel>
    </div>
  );
}
