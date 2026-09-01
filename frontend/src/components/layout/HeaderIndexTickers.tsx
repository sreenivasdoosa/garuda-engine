/**
 * HeaderIndexTickers — the NIFTY / SENSEX strip rendered in the header
 * after the Trade Checklist button. Owns the bottom-slide chart panel
 * state so each card click drops the TradingView-style candlestick chart
 * up from the bottom.
 *
 * Hidden below lg breakpoint (992px). Both cards are individually hidden
 * until they have data — so on cold start the strip starts empty and
 * fills in as REST + WS land.
 */
import React, { useState, useCallback } from 'react';
import { HeaderIndexTicker } from './HeaderIndexTicker';
import { useIndexTicks } from '@/hooks/useIndexTicks';
import BottomSlidePanel from '@/components/common/BottomSlidePanel';
import CandlestickChart from '@/components/common/CandlestickChart';

interface ChartTarget {
  key: string;
  label: string;
}

export const HeaderIndexTickers: React.FC = () => {
  const indices = useIndexTicks();
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);

  const openChart = useCallback((key: string, label: string) => {
    setChartTarget({ key, label });
  }, []);
  const closeChart = useCallback(() => setChartTarget(null), []);

  // Don't render the wrapper at all if neither card has data yet — keeps
  // the header free of an empty div + margin during the brief REST seed.
  const anyVisible = indices.some((idx) => idx.hasData);

  return (
    <>
      {anyVisible && (
        <div className="header-index-tickers-group hidden lg:flex items-center gap-2 ms-6">
          {indices.map((idx) =>
            idx.hasData && idx.lastPrice != null && idx.change != null && idx.changePct != null ? (
              <HeaderIndexTicker
                key={idx.key}
                label={idx.label}
                lastPrice={idx.lastPrice}
                change={idx.change}
                changePct={idx.changePct}
                isLive={!!idx.isLive}
                onChartClick={() => openChart(idx.key, idx.label)}
              />
            ) : null
          )}
        </div>
      )}

      {chartTarget && (
        <BottomSlidePanel
          isOpen
          onClose={closeChart}
          title={chartTarget.label}
          subtitle="Intraday chart"
          height="65vh"
        >
          <div style={{ padding: 16, height: '100%' }}>
            <CandlestickChart
              symbol={chartTarget.key}
              interval="minute"
              showTypeToggle
            />
          </div>
        </BottomSlidePanel>
      )}
    </>
  );
};

export default HeaderIndexTickers;
