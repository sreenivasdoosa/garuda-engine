/**
 * Live Ticks Tab - Real-time tick data display with index badges, straddle badges, and chart panels.
 */

import { useState, useMemo, useEffect } from 'react';
import { useMarketData } from '@/context/MarketDataContext';
import { mdIndicesApi, mdQuotesApi, type IndexSymbol, type Quote } from '@/api/marketDataApi';
import BottomSlidePanel from '@/components/common/BottomSlidePanel';
import CandlestickChart from '@/components/common/CandlestickChart';
import { BsGraphUp } from 'react-icons/bs';

interface ChartPanelState {
  isOpen: boolean;
  symbol: string;
  exchange: string;
  isCustomType: boolean; // true for straddle symbols
}

export default function TicksTab() {
  const { ticks, straddleTicks } = useMarketData();
  const [searchTerm, setSearchTerm] = useState('');
  const [sortField, setSortField] = useState<'symbol' | 'ltp' | 'change' | 'volume'>('symbol');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [indices, setIndices] = useState<IndexSymbol[]>([]);
  const [initialQuotes, setInitialQuotes] = useState<Map<string, Quote>>(new Map());
  const [chartPanel, setChartPanel] = useState<ChartPanelState>({
    isOpen: false, symbol: '', exchange: '', isCustomType: false,
  });

  const openChartPanel = (symbol: string, exchange: string, isCustomType = false) => {
    setChartPanel({ isOpen: true, symbol, exchange, isCustomType });
  };

  const closeChartPanel = () => {
    setChartPanel(prev => ({ ...prev, isOpen: false }));
  };

  // Live tick for the chart
  const chartLiveTick = useMemo(() => {
    if (!chartPanel.isOpen || !chartPanel.symbol) return undefined;
    const fullSymbol = `${chartPanel.exchange}:${chartPanel.symbol}`;
    if (chartPanel.isCustomType) {
      const sTick = straddleTicks.get(fullSymbol);
      if (sTick) return { price: sTick.price, timestamp: sTick.timestamp };
    } else {
      const tick = ticks.get(fullSymbol);
      if (tick) return { price: tick.lastTradedPrice, timestamp: tick.timestamp };
    }
    return undefined;
  }, [chartPanel.isOpen, chartPanel.symbol, chartPanel.exchange, chartPanel.isCustomType, ticks, straddleTicks]);

  const symbolSortOrder = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY', 'CRUDEOIL'];

  const getSymbolSortIndex = (symbol: string): number => {
    const baseSymbol = symbol.replace(/^S-/, '').replace(/ .*$/, '').toUpperCase();
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
    const fetchIndicesAndQuotes = async () => {
      try {
        const data = await mdIndicesApi.getAll();
        if (data.status === 'ok') {
          setIndices(data.indices);
          const symbols = data.indices.map(idx => idx.fullSymbol);
          if (symbols.length > 0) {
            try {
              const quotes = await mdQuotesApi.getQuotes(symbols);
              const quotesMap = new Map<string, Quote>();
              for (const quote of quotes) {
                quotesMap.set(`${quote.exchange}:${quote.tradingSymbol}`, quote);
              }
              setInitialQuotes(quotesMap);
            } catch { /* ignore quotes error */ }
          }
        }
      } catch { /* ignore indices error */ }
    };
    fetchIndicesAndQuotes();
  }, []);

  const indexSymbolSet = useMemo(() => new Set(indices.map(idx => idx.fullSymbol)), [indices]);

  const sortedIndices = useMemo(() =>
    [...indices].sort((a, b) => getSymbolSortIndex(a.symbol) - getSymbolSortIndex(b.symbol)),
  [indices]);

  const sortedStraddleTicks = useMemo(() =>
    Array.from(straddleTicks.values()).sort((a, b) => getSymbolSortIndex(a.symbol) - getSymbolSortIndex(b.symbol)),
  [straddleTicks]);

  const ticksArray = useMemo(() => {
    let arr = Array.from(ticks.values()).filter(tick => {
      const fullSymbol = `${tick.exchange}:${tick.tradingSymbol}`;
      return !indexSymbolSet.has(fullSymbol);
    });
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      arr = arr.filter(t => t.tradingSymbol.toLowerCase().includes(term) || t.exchange.toLowerCase().includes(term));
    }
    arr.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'symbol': comparison = a.tradingSymbol.localeCompare(b.tradingSymbol); break;
        case 'ltp': comparison = a.lastTradedPrice - b.lastTradedPrice; break;
        case 'change': comparison = a.change - b.change; break;
        case 'volume': comparison = a.volume - b.volume; break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return arr;
  }, [ticks, searchTerm, sortField, sortDirection, indexSymbolSet]);

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDirection('asc'); }
  };

  const formatNumber = (num: number, decimals = 2) =>
    num.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

  const formatVolume = (num: number) => {
    if (num >= 10000000) return (num / 10000000).toFixed(2) + ' Cr';
    if (num >= 100000) return (num / 100000).toFixed(2) + ' L';
    if (num >= 1000) return (num / 1000).toFixed(2) + ' K';
    return num.toString();
  };

  const SortIcon = ({ field }: { field: typeof sortField }) => {
    if (sortField !== field) return <i className="bi bi-chevron-expand text-ink-soft" style={{ fontSize: '0.75rem' }}></i>;
    return sortDirection === 'asc'
      ? <i className="bi bi-chevron-up" style={{ fontSize: '0.75rem' }}></i>
      : <i className="bi bi-chevron-down" style={{ fontSize: '0.75rem' }}></i>;
  };

  return (
    <div className="h-full flex flex-col">
      {/* Index Badges */}
      {sortedIndices.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <i className="bi bi-bar-chart-line text-primary-700 dark:text-primary-400"></i>
            <span className="font-semibold" style={{ fontSize: '0.9rem' }}>Indices</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {sortedIndices.map((index) => {
              const tick = ticks.get(index.fullSymbol);
              const quote = initialQuotes.get(index.fullSymbol);
              const ltp = tick?.lastTradedPrice ?? quote?.lastTradedPrice;
              const close = tick?.close ?? quote?.close ?? 0;
              const absoluteChange = (ltp ?? 0) - close;
              const changePercent = close > 0 ? (absoluteChange / close) * 100 : 0;
              const isPositive = absoluteChange >= 0;
              return (
                <div key={index.fullSymbol} className="rounded-card border border-hairline bg-card" style={{
                  minWidth: '180px',
                  background: isPositive ? 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)' : 'linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)',
                  border: 'none', borderRadius: '12px',
                }}>
                  <div className="p-3 py-2 px-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-bold" style={{ fontSize: '0.85rem', color: '#374151' }}>
                          {index.symbol}
                          {index.isFutures && <span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-warning-500 text-black ms-1" style={{ fontSize: '0.6rem', verticalAlign: 'middle' }}>FUT</span>}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>{index.exchange}</div>
                      </div>
                      <div className="text-end">
                        {ltp !== undefined ? (
                          <>
                            <div className="font-bold" style={{ fontSize: '1.1rem', color: isPositive ? '#059669' : '#dc2626' }}>{formatNumber(ltp)}</div>
                            <div style={{ fontSize: '0.75rem', color: isPositive ? '#059669' : '#dc2626' }}>
                              <i className={`bi ${isPositive ? 'bi-caret-up-fill' : 'bi-caret-down-fill'}`}></i>
                              {' '}{formatNumber(Math.abs(absoluteChange))} ({formatNumber(Math.abs(changePercent))}%)
                            </div>
                          </>
                        ) : <div className="text-ink-soft" style={{ fontSize: '0.8rem' }}>--</div>}
                      </div>
                      <button
                        className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 bg-transparent text-ink border border-hairline hover:bg-raised hover:border-primary-500/50 px-2.5 py-1 text-xs ms-2"
                        style={{ background: 'rgba(0,0,0,0.08)', border: 'none', borderRadius: '8px', padding: '4px 7px', lineHeight: 1 }}
                        title="Open Chart"
                        onClick={(e) => { e.stopPropagation(); openChartPanel(index.referenceSymbol, index.exchange); }}
                      >
                        <BsGraphUp style={{ fontSize: '0.9rem', color: '#374151' }} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Straddle Badges */}
      {sortedStraddleTicks.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <i className="bi bi-layers text-primary-700 dark:text-primary-400"></i>
            <span className="font-semibold" style={{ fontSize: '0.9rem' }}>Straddles</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {sortedStraddleTicks.map((sTick) => (
              <div key={`${sTick.exchange}:${sTick.symbol}`} className="rounded-card border border-hairline bg-card" style={{
                minWidth: '220px',
                background: 'linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%)',
                border: 'none', borderRadius: '12px',
              }}>
                <div className="p-3 py-2 px-4">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <div className="font-bold" style={{ fontSize: '0.85rem', color: '#374151' }}>{sTick.symbol}</div>
                      <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>{sTick.referenceSymbol} | {sTick.exchange}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="font-bold" style={{ fontSize: '1.1rem', color: '#4f46e5' }}>{formatNumber(sTick.price)}</div>
                      <button
                        className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 bg-transparent text-ink border border-hairline hover:bg-raised hover:border-primary-500/50 px-2.5 py-1 text-xs"
                        style={{ background: 'rgba(0,0,0,0.08)', border: 'none', borderRadius: '8px', padding: '4px 7px', lineHeight: 1 }}
                        title="Open Chart"
                        onClick={(e) => { e.stopPropagation(); openChartPanel(sTick.symbol, sTick.exchange, true); }}
                      >
                        <BsGraphUp style={{ fontSize: '0.9rem', color: '#374151' }} />
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-between" style={{ fontSize: '0.75rem' }}>
                    <div><span className="text-success-500 dark:text-success-400">CE: {formatNumber(sTick.cePrice)}</span> <span className="text-ink-soft">({formatVolume(sTick.ceOI)})</span></div>
                    <div><span className="text-danger-600 dark:text-danger-400">PE: {formatNumber(sTick.pePrice)}</span> <span className="text-ink-soft">({formatVolume(sTick.peOI)})</span></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <div className="flex w-full [&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:-ml-px [&>*:not(:last-child)]:rounded-r-none text-xs">
          <span className="inline-flex items-center rounded border border-hairline bg-raised px-2 text-sm text-ink-soft"><i className="bi bi-search"></i></span>
          <input type="text" className="w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:bg-raised disabled:opacity-70" placeholder="Search by symbol or exchange..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          {searchTerm && <button className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm" onClick={() => setSearchTerm('')}><i className="bi bi-x"></i></button>}
        </div>
      </div>

      {/* Table */}
      {ticksArray.length === 0 ? (
        <div className="grow flex items-center justify-center">
          <div className="text-center text-ink-soft">
            <i className="bi bi-reception-0" style={{ fontSize: '4rem' }}></i>
            <h5 className="mt-4">No Ticks Yet</h5>
            <p>Waiting for market data...</p>
          </div>
        </div>
      ) : (
        <div className="grow overflow-auto">
          <table className="w-full text-sm [&_thead_th]:bg-raised [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-ink-faint [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_td]:text-ink [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline [&_th]:!py-1.5 [&_td]:!py-1.5 [&_th]:!px-2 [&_td]:!px-2 [&_tbody_tr:hover_td]:bg-raised/50 align-middle mb-0">
            <thead className="sticky top-0 z-[1020] bg-card">
              <tr>
                <th style={{ cursor: 'pointer' }} onClick={() => handleSort('symbol')}>Symbol <SortIcon field="symbol" /></th>
                <th>Exchange</th>
                <th className="text-end" style={{ cursor: 'pointer' }} onClick={() => handleSort('ltp')}>LTP <SortIcon field="ltp" /></th>
                <th className="text-end" style={{ cursor: 'pointer' }} onClick={() => handleSort('change')}>Change <SortIcon field="change" /></th>
                <th className="text-end">Open</th>
                <th className="text-end">High</th>
                <th className="text-end">Low</th>
                <th className="text-end">Close</th>
                <th className="text-end" style={{ cursor: 'pointer' }} onClick={() => handleSort('volume')}>Volume <SortIcon field="volume" /></th>
                <th className="text-end">OI</th>
                <th className="text-end">Time</th>
                <th className="text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ticksArray.map((tick) => {
                const changePercent = tick.close > 0 ? ((tick.lastTradedPrice - tick.close) / tick.close * 100) : 0;
                const isPositive = tick.change >= 0;
                return (
                  <tr key={`${tick.exchange}:${tick.tradingSymbol}`}>
                    <td><span className="font-semibold">{tick.tradingSymbol}</span></td>
                    <td><span className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-raised text-ink-soft">{tick.exchange}</span></td>
                    <td className="text-end font-semibold">{formatNumber(tick.lastTradedPrice)}</td>
                    <td className={`text-end ${isPositive ? 'text-success-500 dark:text-success-400' : 'text-danger-600 dark:text-danger-400'}`}>
                      <i className={`bi ${isPositive ? 'bi-caret-up-fill' : 'bi-caret-down-fill'}`}></i>
                      {' '}{formatNumber(Math.abs(tick.change))} ({formatNumber(Math.abs(changePercent))}%)
                    </td>
                    <td className="text-end">{formatNumber(tick.open)}</td>
                    <td className="text-end text-success-500 dark:text-success-400">{formatNumber(tick.high)}</td>
                    <td className="text-end text-danger-600 dark:text-danger-400">{formatNumber(tick.low)}</td>
                    <td className="text-end">{formatNumber(tick.close)}</td>
                    <td className="text-end">{formatVolume(tick.volume)}</td>
                    <td className="text-end">{formatVolume(tick.oi)}</td>
                    <td className="text-end text-ink-soft" style={{ fontSize: '0.8rem' }}>
                      {tick.timestamp ? new Date(tick.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }) : '-'}
                    </td>
                    <td className="text-center">
                      <button
                        className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-2.5 py-1 text-xs py-0 px-1"
                        title="Open Chart"
                        onClick={() => openChartPanel(tick.tradingSymbol, tick.exchange)}
                      >
                        <BsGraphUp />
                      </button>
                    </td>
                  </tr>
                );
              })}
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
