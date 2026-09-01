/**
 * Live Straddles Tab - Real-time straddle data display with chart panels.
 */

import { useState, useMemo, useEffect } from 'react';
import { useMarketData } from '@/context/MarketDataContext';
import { mdIndicesApi, mdStraddleTicksApi, type IndexSymbol, type StraddleTickResponse } from '@/api/marketDataApi';
import BottomSlidePanel from '@/components/common/BottomSlidePanel';
import CandlestickChart from '@/components/common/CandlestickChart';
import { BsGraphUp } from 'react-icons/bs';

interface StraddleData {
  exchange: string;
  symbol: string;
  referenceSymbol: string;
  ceSymbol: string;
  peSymbol: string;
  cePrice: number;
  pePrice: number;
  price: number;
  ceOI: number;
  peOI: number;
  timestamp: number;
  hasLiveData: boolean;
}

interface ChartPanelState {
  isOpen: boolean;
  symbol: string;
  exchange: string;
}

export default function StraddlesTab() {
  const { straddleTicks } = useMarketData();
  const [indices, setIndices] = useState<IndexSymbol[]>([]);
  const [apiTicks, setApiTicks] = useState<Map<string, StraddleTickResponse>>(new Map());
  const [loadingIndices, setLoadingIndices] = useState(true);
  const [chartPanel, setChartPanel] = useState<ChartPanelState>({
    isOpen: false, symbol: '', exchange: '',
  });

  const openChartPanel = (symbol: string, exchange: string) => {
    setChartPanel({ isOpen: true, symbol, exchange });
  };

  const closeChartPanel = () => {
    setChartPanel(prev => ({ ...prev, isOpen: false }));
  };

  // Live tick for the chart — always straddle
  const chartLiveTick = useMemo(() => {
    if (!chartPanel.isOpen || !chartPanel.symbol) return undefined;
    const fullSymbol = `${chartPanel.exchange}:${chartPanel.symbol}`;
    const sTick = straddleTicks.get(fullSymbol);
    if (sTick) return { price: sTick.price, timestamp: sTick.timestamp };
    return undefined;
  }, [chartPanel.isOpen, chartPanel.symbol, chartPanel.exchange, straddleTicks]);

  const symbolSortOrder = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY', 'CRUDEOIL'];

  const getSymbolSortIndex = (symbol: string): number => {
    const baseSymbol = symbol.replace(/^S-/, '').toUpperCase();
    let bestIndex = -1;
    let bestMatchLen = 0;
    for (let i = 0; i < symbolSortOrder.length; i++) {
      const s = symbolSortOrder[i];
      if (baseSymbol === s || baseSymbol.includes(s)) {
        if (s.length > bestMatchLen) { bestMatchLen = s.length; bestIndex = i; }
      }
    }
    return bestIndex === -1 ? symbolSortOrder.length : bestIndex;
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        const data = await mdIndicesApi.getAll();
        if (data.status === 'ok') {
          setIndices(data.indices);
          if (data.indices.length > 0) {
            const symbols = data.indices.map(idx => idx.fullStraddleSymbol);
            try {
              const ticks = await mdStraddleTicksApi.getLatest(symbols);
              const ticksMap = new Map<string, StraddleTickResponse>();
              for (const tick of ticks) {
                ticksMap.set(`${tick.exchange}:${tick.symbol}`, tick);
              }
              setApiTicks(ticksMap);
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ } finally {
        setLoadingIndices(false);
      }
    };
    fetchData();
  }, []);

  const sortedStraddles = useMemo(() => {
    const straddleMap = new Map<string, StraddleData>();

    for (const index of indices) {
      straddleMap.set(index.fullStraddleSymbol, {
        exchange: index.exchange, symbol: index.straddleSymbol, referenceSymbol: index.referenceSymbol,
        ceSymbol: '-', peSymbol: '-', cePrice: 0, pePrice: 0, price: 0, ceOI: 0, peOI: 0, timestamp: 0, hasLiveData: false,
      });
    }

    for (const [key, apiTick] of apiTicks) {
      const existing = straddleMap.get(key);
      if (existing) {
        straddleMap.set(key, {
          ...existing, ceSymbol: apiTick.ceSymbol, peSymbol: apiTick.peSymbol,
          cePrice: apiTick.cePrice, pePrice: apiTick.pePrice, price: apiTick.price,
          ceOI: apiTick.ceOI, peOI: apiTick.peOI, timestamp: apiTick.timestamp || 0, hasLiveData: false,
        });
      }
    }

    for (const [key, sTick] of straddleTicks) {
      straddleMap.set(key, {
        exchange: sTick.exchange, symbol: sTick.symbol, referenceSymbol: sTick.referenceSymbol,
        ceSymbol: sTick.ceSymbol, peSymbol: sTick.peSymbol, cePrice: sTick.cePrice, pePrice: sTick.pePrice,
        price: sTick.price, ceOI: sTick.ceOI, peOI: sTick.peOI, timestamp: sTick.timestamp, hasLiveData: true,
      });
    }

    return Array.from(straddleMap.values()).sort((a, b) => getSymbolSortIndex(a.symbol) - getSymbolSortIndex(b.symbol));
  }, [indices, apiTicks, straddleTicks]);

  const formatNumber = (num: number, decimals = 2) => {
    if (num === 0) return '-';
    return num.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  const formatOI = (num: number) => {
    if (num === 0) return '-';
    if (num >= 10000000) return (num / 10000000).toFixed(2) + ' Cr';
    if (num >= 100000) return (num / 100000).toFixed(2) + ' L';
    if (num >= 1000) return (num / 1000).toFixed(2) + ' K';
    return num.toString();
  };

  const liveCount = sortedStraddles.filter(s => s.hasLiveData).length;

  if (loadingIndices) {
    return (
      <div className="flex justify-center items-center p-12">
        <div className="inline-block h-6 w-6 animate-spin rounded-full border-[0.2em] border-current border-r-transparent align-[-0.125em] text-primary-500 text-primary-700 dark:text-primary-400" role="status"><span className="sr-only">Loading...</span></div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-ink-soft">{liveCount > 0 ? `${liveCount} live / ` : ''}{sortedStraddles.length} straddles</span>
      </div>

      {sortedStraddles.length === 0 ? (
        <div className="grow flex items-center justify-center">
          <div className="text-center text-ink-soft">
            <i className="bi bi-layers" style={{ fontSize: '4rem' }}></i>
            <h5 className="mt-4">No Straddles Configured</h5>
            <p>No index symbols found in the configuration.</p>
          </div>
        </div>
      ) : (
        <div className="grow overflow-auto">
          <table className="w-full text-sm [&_thead_th]:bg-raised [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-ink-faint [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_td]:text-ink [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline [&_th]:!py-1.5 [&_td]:!py-1.5 [&_th]:!px-2 [&_td]:!px-2 [&_tbody_tr:hover_td]:bg-raised/50 align-middle mb-0">
            <thead className="sticky top-0 z-[1020] bg-card">
              <tr>
                <th>Straddle</th>
                <th>Exchange</th>
                <th className="text-end">Straddle Price</th>
                <th>CE Symbol</th>
                <th className="text-end">CE Price</th>
                <th className="text-end">CE OI</th>
                <th>PE Symbol</th>
                <th className="text-end">PE Price</th>
                <th className="text-end">PE OI</th>
                <th className="text-end">Time</th>
                <th className="text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedStraddles.map((sTick) => (
                <tr key={`${sTick.exchange}:${sTick.symbol}`} className={!sTick.hasLiveData ? 'bg-raised' : ''}>
                  <td>
                    <span className="font-semibold">{sTick.symbol}</span>
                    <br /><small className="text-ink-soft">{sTick.referenceSymbol}</small>
                  </td>
                  <td><span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-raised text-ink-soft">{sTick.exchange}</span></td>
                  <td className="text-end">
                    {sTick.price > 0 ? (
                      <span className={`inline-block rounded-md px-[.55em] py-[.35em] text-center text-base font-semibold leading-none whitespace-nowrap text-white ${sTick.hasLiveData ? 'bg-primary-500' : 'bg-ink-soft'}`}>{formatNumber(sTick.price)}</span>
                    ) : <span className="text-ink-soft">-</span>}
                  </td>
                  <td><span className="text-success-500 dark:text-success-400">{sTick.ceSymbol}</span></td>
                  <td className="text-end font-semibold text-success-500 dark:text-success-400">{formatNumber(sTick.cePrice)}</td>
                  <td className="text-end text-ink-soft">{formatOI(sTick.ceOI)}</td>
                  <td><span className="text-danger-600 dark:text-danger-400">{sTick.peSymbol}</span></td>
                  <td className="text-end font-semibold text-danger-600 dark:text-danger-400">{formatNumber(sTick.pePrice)}</td>
                  <td className="text-end text-ink-soft">{formatOI(sTick.peOI)}</td>
                  <td className="text-end text-ink-soft" style={{ fontSize: '0.8rem' }}>
                    {sTick.timestamp ? new Date(sTick.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }) : '-'}
                  </td>
                  <td className="text-center">
                    <button
                      className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-2.5 py-1 text-xs py-0 px-1"
                      title="Open Chart"
                      onClick={() => openChartPanel(sTick.symbol, sTick.exchange)}
                    >
                      <BsGraphUp />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Chart Panel */}
      <BottomSlidePanel
        isOpen={chartPanel.isOpen}
        onClose={closeChartPanel}
        title={chartPanel.symbol}
        subtitle={chartPanel.exchange}
        height="90vh"
      >
        {chartPanel.isOpen && (
          <CandlestickChart
            symbol={`${chartPanel.exchange}:${chartPanel.symbol}`}
            interval="minute"
            showTypeToggle={true}
            liveTick={chartLiveTick}
          />
        )}
      </BottomSlidePanel>
    </div>
  );
}
