import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, type IChartApi, type ISeriesApi, ColorType, LineSeries } from 'lightweight-charts';
import { useDarkMode } from '@/hooks/useDarkMode';
import { terminalService, type AggregatedPnlSnapshot } from '@/services/terminal/terminalService';
import type { UserTradeSummary } from '@/types/terminal';
import { format } from 'date-fns';
import {
  BsChevronLeft,
  BsChevronRight,
  BsDash,
  BsPlus,
  BsArrowsAngleExpand,
  BsCurrencyRupee,
  BsBank,
  BsArrowClockwise,
  BsExclamationTriangle,
  BsGraphUp,
} from 'react-icons/bs';

type ChartMetric = 'pnl' | 'margin';
type PnlDisplayMode = 'algo' | 'broker' | 'both';

interface PnlChartProps {
  date?: string; // YYYY-MM-DD format, defaults to today
  height?: number;
  /** Live summaries from WebSocket for real-time updates */
  liveSummaries?: UserTradeSummary[];
  /** Top-level terminal trading mode — gates the chart's Live/Paper selector. */
  tradingMode?: 'live' | 'paper' | 'mixed';
  /** Algo-only mode: show only the Algo P&L line and hide the Algo/Broker/Both toggle. Used by
   *  the admin terminal when the viewer lacks ALGO_BROKER_COMPARE. Default false (show toggle). */
  algoOnly?: boolean;
}

/**
 * PnL Chart component using TradingView Lightweight Charts.
 * Displays aggregated P&L and margin data throughout the trading day.
 */
// lightweight-charts takes concrete color strings (not CSS vars), so read the
// live token value at chart-build time and re-run when the theme flips.
const readToken = (name: string, alpha = 1): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = v.split(/\s+/);
  if (parts.length < 3) return alpha === 1 ? '#888' : 'rgba(136,136,136,' + alpha + ')';
  const [r, g, b] = parts;
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export default function PnlChart({
  date,
  height,
  liveSummaries,
  tradingMode = 'mixed',
  algoOnly = false,
}: PnlChartProps) {
  const { isDark } = useDarkMode();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const algoPnlSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const brokerPnlSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const marginPctSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const [chartHeight, setChartHeight] = useState(height || 400);

  const [snapshots, setSnapshots] = useState<AggregatedPnlSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<ChartMetric>('pnl');
  const [pnlDisplayMode, setPnlDisplayMode] = useState<PnlDisplayMode>('algo');
  // Algo-only mode locks the display to Algo (the toggle is hidden), so no broker series renders.
  useEffect(() => {
    if (algoOnly) setPnlDisplayMode('algo');
  }, [algoOnly]);
  // Live vs paper series. The top-level terminal mode locks this: live/paper
  // force the matching series (dropdown disabled); only 'mixed' lets the user pick.
  const [chartModeState, setChartModeState] = useState<'live' | 'paper'>('live');
  const lockedChartMode: 'live' | 'paper' | null =
    tradingMode === 'live' ? 'live' : tradingMode === 'paper' ? 'paper' : null;
  const chartMode: 'live' | 'paper' = lockedChartMode ?? chartModeState;
  const [hoveredData, setHoveredData] = useState<{
    time: string;
    algoPnl?: number;
    algoPnlPct?: number;
    brokerPnl?: number;
    brokerPnlPct?: number;
    totalMargin?: number;
    utilizedMargin?: number;
    marginUtilizationPct?: number;
  } | null>(null);

  // Calculate chart height to fill available space
  useEffect(() => {
    const calculateHeight = () => {
      if (chartContainerRef.current) {
        const availableHeight = chartContainerRef.current.clientHeight;
        if (availableHeight > 0) {
          setChartHeight(availableHeight);
        }
      } else if (height) {
        setChartHeight(height);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      calculateHeight();
    });

    if (chartContainerRef.current) {
      resizeObserver.observe(chartContainerRef.current);
    }

    const timeout = setTimeout(calculateHeight, 50);

    return () => {
      resizeObserver.disconnect();
      clearTimeout(timeout);
    };
  }, [height]);

  // Stabilize date
  const dateStr = date || format(new Date(), 'yyyy-MM-dd');

  // Fetch data
  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }
    setError(null);

    try {
      const response = await terminalService.getPnlChartData(dateStr, chartMode);
      setSnapshots(response.snapshots);
    } catch (err) {
      console.error('Failed to fetch PnL chart data:', err);
      if (showLoading) {
        setError('Failed to load chart data');
      }
    } finally {
      setLoading(false);
    }
  }, [dateStr, chartMode]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Get timezone offset in seconds
  const timezoneOffsetSeconds = new Date().getTimezoneOffset() * -60;

  // Track previous metric and pnl display mode to detect changes
  const prevMetricRef = useRef<ChartMetric>(selectedMetric);
  const prevPnlDisplayModeRef = useRef<PnlDisplayMode>(pnlDisplayMode);

  // Create and update chart
  useEffect(() => {
    if (!chartContainerRef.current || loading || snapshots.length === 0) {
      // The chart container is unmounted whenever the component early-returns a
      // spinner / "no data" / error — e.g. while a Live<->Paper mode switch
      // refetches (loading), or when the target mode has no snapshots. Drop the
      // now-orphaned chart instance (bound to the detached DOM node) so it gets
      // recreated on the fresh container when data returns. Without this, the
      // series-update path below writes to the detached chart and the remounted
      // container stays blank.
      if (chartRef.current) {
        (chartRef.current as unknown as { _cleanup?: () => void })._cleanup?.();
        chartRef.current.remove();
        chartRef.current = null;
        algoPnlSeriesRef.current = null;
        brokerPnlSeriesRef.current = null;
        marginPctSeriesRef.current = null;
      }
      return;
    }

    const metricChanged = prevMetricRef.current !== selectedMetric;
    const pnlModeChanged = prevPnlDisplayModeRef.current !== pnlDisplayMode;
    prevMetricRef.current = selectedMetric;
    prevPnlDisplayModeRef.current = pnlDisplayMode;

    // Recreate chart if it doesn't exist or metric/pnl mode changed
    if (!chartRef.current || metricChanged || pnlModeChanged) {
      // Clean up existing chart
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        algoPnlSeriesRef.current = null;
        brokerPnlSeriesRef.current = null;
        marginPctSeriesRef.current = null;
      }

      // Create chart
      const containerHeight = chartContainerRef.current.clientHeight || chartHeight;
      const chart = createChart(chartContainerRef.current, {
        width: chartContainerRef.current.clientWidth,
        height: containerHeight,
        layout: {
          background: { type: ColorType.Solid, color: readToken('--c-card') },
          textColor: readToken('--c-ink-soft'),
        },
        grid: {
          vertLines: { color: readToken('--c-hairline', 0.4) },
          horzLines: { color: readToken('--c-hairline', 0.4) },
        },
        crosshair: {
          mode: 1,
        },
        rightPriceScale: {
          borderColor: readToken('--c-hairline'),
        },
        timeScale: {
          borderColor: readToken('--c-hairline'),
          timeVisible: true,
          secondsVisible: false,
        },
      });

      chartRef.current = chart;

      // Create series based on selected metric
      if (selectedMetric === 'pnl') {
        // Algo P&L line (green) - show if mode is 'algo' or 'both'
        if (pnlDisplayMode === 'algo' || pnlDisplayMode === 'both') {
          algoPnlSeriesRef.current = chart.addSeries(LineSeries, {
            color: '#26a69a',
            lineWidth: 2,
            title: 'Algo P&L',
          });
        }

        // Broker P&L line (blue) - show if mode is 'broker' or 'both'
        if (pnlDisplayMode === 'broker' || pnlDisplayMode === 'both') {
          brokerPnlSeriesRef.current = chart.addSeries(LineSeries, {
            color: '#2962FF',
            lineWidth: 2,
            title: 'Broker P&L',
          });
        }
      } else {
        // Margin Utilization Percentage line (orange)
        marginPctSeriesRef.current = chart.addSeries(LineSeries, {
          color: '#ff9800',
          lineWidth: 2,
          title: 'Margin Utilization %',
        });
      }

      // Subscribe to crosshair move for legend
      chart.subscribeCrosshairMove((param) => {
        if (!param.time) {
          setHoveredData(null);
          return;
        }

        // Find the snapshot for this time
        const timestamp = (param.time as number - timezoneOffsetSeconds) * 1000;
        const snapshot = snapshots.find(s => {
          return Math.abs(s.snapshotTimestamp - timestamp) < 60000; // Within 1 minute
        });

        if (snapshot) {
          const time = new Date(snapshot.snapshotTimestamp).toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          const marginUtilizationPct = snapshot.totalMargin > 0
            ? (snapshot.totalUtilizedMargin / snapshot.totalMargin) * 100
            : 0;
          const algoPnlPct = snapshot.totalCapital > 0
            ? (snapshot.totalAlgoPnl / snapshot.totalCapital) * 100
            : 0;
          const totalCapitalWithExternal = snapshot.totalCapital + snapshot.totalExternalCapital;
          const brokerPnlPct = totalCapitalWithExternal > 0
            ? (snapshot.totalBrokerPnl / totalCapitalWithExternal) * 100
            : 0;
          setHoveredData({
            time,
            algoPnl: snapshot.totalAlgoPnl,
            algoPnlPct,
            brokerPnl: snapshot.totalBrokerPnl,
            brokerPnlPct,
            totalMargin: snapshot.totalMargin,
            utilizedMargin: snapshot.totalUtilizedMargin,
            marginUtilizationPct,
          });
        }
      });

      // Handle resize
      const handleResize = () => {
        if (chartContainerRef.current && chartRef.current) {
          chartRef.current.applyOptions({
            width: chartContainerRef.current.clientWidth,
            height: chartContainerRef.current.clientHeight,
          });
        }
      };

      const resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(chartContainerRef.current);
      window.addEventListener('resize', handleResize);

      // Store cleanup function
      const cleanup = () => {
        resizeObserver.disconnect();
        window.removeEventListener('resize', handleResize);
      };
      (chartRef.current as any)._cleanup = cleanup;
    }

    // Deduplicate snapshots by timestamp (keep last value for each second)
    // lightweight-charts requires strictly ascending unique timestamps
    const deduplicatedSnapshots = snapshots.reduce((acc, snapshot) => {
      const timeKey = Math.floor(snapshot.snapshotTimestamp / 1000) + timezoneOffsetSeconds;
      acc.set(timeKey, snapshot);
      return acc;
    }, new Map<number, AggregatedPnlSnapshot>());

    // Convert to sorted array
    const sortedSnapshots = Array.from(deduplicatedSnapshots.entries())
      .sort((a, b) => a[0] - b[0]);

    // Update series data - convert epoch millis to seconds and add timezone offset for chart display
    if (selectedMetric === 'pnl') {
      if (algoPnlSeriesRef.current) {
        const algoPnlData = sortedSnapshots.map(([time, snapshot]) => ({
          time: time as any,
          value: snapshot.totalAlgoPnl,
        }));
        algoPnlSeriesRef.current.setData(algoPnlData);
      }
      if (brokerPnlSeriesRef.current) {
        const brokerPnlData = sortedSnapshots.map(([time, snapshot]) => ({
          time: time as any,
          value: snapshot.totalBrokerPnl,
        }));
        brokerPnlSeriesRef.current.setData(brokerPnlData);
      }
    } else {
      if (marginPctSeriesRef.current) {
        const marginPctData = sortedSnapshots.map(([time, snapshot]) => ({
          time: time as any,
          value: snapshot.totalMargin > 0
            ? (snapshot.totalUtilizedMargin / snapshot.totalMargin) * 100
            : 0,
        }));
        marginPctSeriesRef.current.setData(marginPctData);
      }
    }

    return () => {
      // Only cleanup on unmount
    };
  }, [loading, chartHeight, selectedMetric, pnlDisplayMode, snapshots, timezoneOffsetSeconds, isDark]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (chartRef.current) {
        if ((chartRef.current as any)._cleanup) {
          (chartRef.current as any)._cleanup();
        }
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, []);

  // Auto-refresh every minute
  useEffect(() => {
    const interval = setInterval(() => {
      fetchData(false);
    }, 60000);

    return () => clearInterval(interval);
  }, [fetchData]);

  // Real-time update from WebSocket summaries
  useEffect(() => {
    if (!liveSummaries || liveSummaries.length === 0) return;
    if (loading || snapshots.length === 0) return;

    // Calculate aggregated values from the live (WebSocket) summaries, split by
    // the selected chart mode so the real-time point matches the stored series:
    //   paper → paper-only P&L; live → combined minus paper. Paper has no real
    //   margin, so margin stays live-only (0 effect on the paper series).
    let totalAlgoPnl = 0;
    let totalBrokerPnl = 0;
    let totalMargin = 0;
    let totalUtilizedMargin = 0;

    for (const summary of liveSummaries) {
      const paperAlgo = summary.paperAlgoPnl || 0;
      const paperBroker = summary.paperBrokerPnl || 0;
      if (chartMode === 'paper') {
        totalAlgoPnl += paperAlgo;
        totalBrokerPnl += paperBroker;
      } else {
        totalAlgoPnl += (summary.algoPnl || 0) - paperAlgo;
        totalBrokerPnl += (summary.brokerPnl || 0) - paperBroker;
        totalMargin += summary.totalMargin || 0;
        totalUtilizedMargin += summary.utilizedMargin || 0;
      }
    }

    // Use the last snapshot's timestamp + 1 minute as the live update point
    // This ensures all live updates within a minute update the same point
    const lastSnapshot = snapshots[snapshots.length - 1];
    const lastSnapshotTime = lastSnapshot.snapshotTimestamp;
    // Add 60 seconds (1 minute) to the last snapshot time for the "live" point
    const livePointTime = (Math.floor(lastSnapshotTime / 1000) + 60 + timezoneOffsetSeconds) as any;

    // Update chart series with live data
    if (selectedMetric === 'pnl') {
      if (algoPnlSeriesRef.current && (pnlDisplayMode === 'algo' || pnlDisplayMode === 'both')) {
        algoPnlSeriesRef.current.update({ time: livePointTime, value: totalAlgoPnl });
      }
      if (brokerPnlSeriesRef.current && (pnlDisplayMode === 'broker' || pnlDisplayMode === 'both')) {
        brokerPnlSeriesRef.current.update({ time: livePointTime, value: totalBrokerPnl });
      }
    } else {
      if (marginPctSeriesRef.current) {
        const marginPct = totalMargin > 0 ? (totalUtilizedMargin / totalMargin) * 100 : 0;
        marginPctSeriesRef.current.update({ time: livePointTime, value: marginPct });
      }
    }
  }, [liveSummaries, loading, snapshots, selectedMetric, pnlDisplayMode, chartMode, timezoneOffsetSeconds]);

  // Chart navigation handlers
  const handleZoomIn = () => {
    if (chartRef.current) {
      const timeScale = chartRef.current.timeScale();
      const visibleRange = timeScale.getVisibleLogicalRange();
      if (visibleRange) {
        const rangeSize = visibleRange.to - visibleRange.from;
        const center = (visibleRange.from + visibleRange.to) / 2;
        const newRangeSize = rangeSize * 0.7;
        timeScale.setVisibleLogicalRange({
          from: center - newRangeSize / 2,
          to: center + newRangeSize / 2,
        });
      }
    }
  };

  const handleZoomOut = () => {
    if (chartRef.current) {
      const timeScale = chartRef.current.timeScale();
      const visibleRange = timeScale.getVisibleLogicalRange();
      if (visibleRange) {
        const rangeSize = visibleRange.to - visibleRange.from;
        const center = (visibleRange.from + visibleRange.to) / 2;
        const newRangeSize = rangeSize * 1.4;
        timeScale.setVisibleLogicalRange({
          from: center - newRangeSize / 2,
          to: center + newRangeSize / 2,
        });
      }
    }
  };

  const handleScrollLeft = () => {
    if (chartRef.current) {
      const timeScale = chartRef.current.timeScale();
      const visibleRange = timeScale.getVisibleLogicalRange();
      if (visibleRange) {
        const rangeSize = visibleRange.to - visibleRange.from;
        const scrollAmount = rangeSize * 0.3;
        timeScale.setVisibleLogicalRange({
          from: visibleRange.from - scrollAmount,
          to: visibleRange.to - scrollAmount,
        });
      }
    }
  };

  const handleScrollRight = () => {
    if (chartRef.current) {
      const timeScale = chartRef.current.timeScale();
      const visibleRange = timeScale.getVisibleLogicalRange();
      if (visibleRange) {
        const rangeSize = visibleRange.to - visibleRange.from;
        const scrollAmount = rangeSize * 0.3;
        timeScale.setVisibleLogicalRange({
          from: visibleRange.from + scrollAmount,
          to: visibleRange.to + scrollAmount,
        });
      }
    }
  };

  const handleResetZoom = () => {
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  if (loading) {
    return (
      <div ref={containerRef} className="flex items-center justify-center h-full">
        <div className="inline-block h-6 w-6 animate-spin rounded-full border-[0.2em] border-current border-r-transparent align-[-0.125em] text-primary-500 text-primary-700 dark:text-primary-400" role="status">
          <span className="sr-only">Loading...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div ref={containerRef} className="h-full p-4">
        <div className="mb-3 rounded border px-3 py-2 text-sm border-danger-500/30 bg-danger-500/10 text-danger-700 dark:text-danger-300" role="alert">
          <BsExclamationTriangle className="me-2" />
          {error}
        </div>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div ref={containerRef} className="flex flex-col items-center justify-center text-ink-soft h-full">
        <BsGraphUp style={{ fontSize: '3rem' }} />
        <p className="mt-4">No chart data available for {dateStr}</p>
        <small>Snapshots are recorded every minute during market hours</small>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full p-4">
      {/* Header Controls */}
      <div className="flex justify-between items-center mb-2 shrink-0">
        <div className="flex items-center gap-4">
          <small className="text-ink-soft">
            {snapshots.length} data points | {dateStr}
          </small>
          {hoveredData && (
            <div className="flex items-center gap-2 font-mono" style={{ fontSize: '0.8rem' }}>
              <span className="text-ink-soft">{hoveredData.time}</span>
              {selectedMetric === 'pnl' ? (
                <>
                  {(pnlDisplayMode === 'algo' || pnlDisplayMode === 'both') && (
                    <span>Algo: <strong className={hoveredData.algoPnl! >= 0 ? 'text-success-500 dark:text-success-400' : 'text-danger-600 dark:text-danger-400'}>{formatCurrency(hoveredData.algoPnl!)} ({hoveredData.algoPnlPct?.toFixed(2)}%)</strong></span>
                  )}
                  {(pnlDisplayMode === 'broker' || pnlDisplayMode === 'both') && (
                    <span>Broker: <strong className={hoveredData.brokerPnl! >= 0 ? 'text-success-500 dark:text-success-400' : 'text-danger-600 dark:text-danger-400'}>{formatCurrency(hoveredData.brokerPnl!)} ({hoveredData.brokerPnlPct?.toFixed(2)}%)</strong></span>
                  )}
                </>
              ) : (
                <>
                  <span>Utilization: <strong className="text-warning-700 dark:text-warning-400">{hoveredData.marginUtilizationPct?.toFixed(1)}%</strong></span>
                  <span>Used: <strong className="text-ink-soft">{formatCurrency(hoveredData.utilizedMargin!)}</strong></span>
                  <span>Total: <strong className="text-ink-soft">{formatCurrency(hoveredData.totalMargin!)}</strong></span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2 items-center">
          {/* Navigation Controls */}
          <div className="inline-flex [&>button]:rounded-none [&>button]:-ml-px [&>*:first-child]:rounded-l [&>*:first-child]:ml-0 [&>*:last-child]:rounded-r">
            <button className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm" onClick={handleScrollLeft} title="Scroll Left">
              <BsChevronLeft />
            </button>
            <button className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm" onClick={handleZoomOut} title="Zoom Out">
              <BsDash />
            </button>
            <button className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm" onClick={handleResetZoom} title="Reset Zoom">
              <BsArrowsAngleExpand />
            </button>
            <button className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm" onClick={handleZoomIn} title="Zoom In">
              <BsPlus />
            </button>
            <button className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm" onClick={handleScrollRight} title="Scroll Right">
              <BsChevronRight />
            </button>
          </div>
          {/* Live / Paper selector — always present. Locked & disabled when the
              terminal mode is live/paper; user-selectable only in mixed. */}
          <select
            className="w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:bg-raised disabled:opacity-70 py-1 text-xs"
            style={{ width: 'auto' }}
            value={chartMode}
            disabled={lockedChartMode !== null}
            onChange={(e) => setChartModeState(e.target.value as 'live' | 'paper')}
            title={lockedChartMode !== null
              ? `Locked to ${lockedChartMode} by the terminal mode selector`
              : 'Show the live or paper P&L series'}
          >
            <option value="live">Live</option>
            <option value="paper">Paper</option>
          </select>
          {/* P&L Display Mode Toggle - only show when P&L metric is selected (hidden in algo-only mode) */}
          {selectedMetric === 'pnl' && !algoOnly && (
            <div className="inline-flex [&>button]:rounded-none [&>button]:-ml-px [&>*:first-child]:rounded-l [&>*:first-child]:ml-0 [&>*:last-child]:rounded-r">
              <button
                className={`inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 px-2.5 py-1 text-xs ${pnlDisplayMode === 'algo' ? 'bg-success-600 text-white hover:bg-success-700' : 'border border-success-600 text-success-700 dark:border-success-500 dark:text-success-400 hover:bg-success-500/10'}`}
                onClick={() => setPnlDisplayMode('algo')}
                title="Show Algo P&L only"
              >
                Algo
              </button>
              <button
                className={`inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 px-2.5 py-1 text-xs ${pnlDisplayMode === 'broker' ? 'bg-primary-600 text-white hover:bg-primary-700' : 'border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10'}`}
                onClick={() => setPnlDisplayMode('broker')}
                title="Show Broker P&L only"
              >
                Broker
              </button>
              <button
                className={`inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 px-2.5 py-1 text-xs ${pnlDisplayMode === 'both' ? 'bg-transparent text-ink border border-hairline hover:bg-raised hover:border-primary-500/50' : 'border border-hairline text-ink hover:bg-raised'}`}
                onClick={() => setPnlDisplayMode('both')}
                title="Show both Algo & Broker P&L"
              >
                Both
              </button>
            </div>
          )}
          {/* Metric Toggle */}
          <div className="inline-flex [&>button]:rounded-none [&>button]:-ml-px [&>*:first-child]:rounded-l [&>*:first-child]:ml-0 [&>*:last-child]:rounded-r">
            <button
              className={`inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 px-2.5 py-1 text-xs ${selectedMetric === 'pnl' ? 'bg-primary-600 text-white hover:bg-primary-700' : 'border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10'}`}
              onClick={() => setSelectedMetric('pnl')}
              title="P&L Chart"
            >
              <BsCurrencyRupee className="me-1" />
              P&L
            </button>
            <button
              className={`inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 px-2.5 py-1 text-xs ${selectedMetric === 'margin' ? 'bg-primary-600 text-white hover:bg-primary-700' : 'border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10'}`}
              onClick={() => setSelectedMetric('margin')}
              title="Margin Chart"
            >
              <BsBank className="me-1" />
              Margin
            </button>
          </div>
          {/* Refresh Button */}
          <button className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-2.5 py-1 text-xs" onClick={() => fetchData(false)} title="Refresh">
            <BsArrowClockwise />
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-6 mb-2 text-[0.875em]">
        {selectedMetric === 'pnl' ? (
          <>
            {(pnlDisplayMode === 'algo' || pnlDisplayMode === 'both') && (
              <div className="flex items-center gap-1">
                <div style={{ width: 16, height: 3, backgroundColor: '#26a69a' }}></div>
                <span>Algo P&L</span>
              </div>
            )}
            {(pnlDisplayMode === 'broker' || pnlDisplayMode === 'both') && (
              <div className="flex items-center gap-1">
                <div style={{ width: 16, height: 3, backgroundColor: '#2962FF' }}></div>
                <span>Broker P&L</span>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center gap-1">
            <div style={{ width: 16, height: 3, backgroundColor: '#ff9800' }}></div>
            <span>Margin Utilization %</span>
          </div>
        )}
      </div>

      {/* Chart Container */}
      <div ref={chartContainerRef} className="grow" style={{ width: '100%', minHeight: 0 }} />
    </div>
  );
}
