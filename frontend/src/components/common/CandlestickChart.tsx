import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, type IChartApi, type ISeriesApi, ColorType, CandlestickSeries, LineSeries } from 'lightweight-charts';
import { useDarkMode } from '@/hooks/useDarkMode';
import { mdHistoryApi, type OHLCCandle, type HistoryInterval } from '@/api/marketDataApi';
import { BsGraphUp, BsBarChart, BsChevronLeft, BsChevronRight, BsDash, BsPlus, BsArrowsAngleExpand, BsExclamationTriangle } from 'react-icons/bs';

type ChartType = 'candlestick' | 'line';

// lightweight-charts needs concrete colors (not CSS vars); read the live token
// at build time and rebuild when the theme flips (isDark in the effect deps).
const readToken = (name: string, alpha = 1): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = v.split(/\s+/);
  if (parts.length < 3) return alpha === 1 ? '#888' : 'rgba(136,136,136,' + alpha + ')';
  const [r, g, b] = parts;
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

interface LiveTickData {
  price: number;
  timestamp: number;
}

interface CandlestickChartProps {
  symbol: string;           // Full symbol with exchange, e.g., "NSE:S-NIFTY"
  interval?: HistoryInterval;
  date?: Date;              // Date to fetch history for (defaults to today)
  height?: number;
  showTypeToggle?: boolean; // Show button to toggle between candlestick and line
  liveTick?: LiveTickData;  // Live tick data from WebSocket for real-time updates
}

/**
 * Reusable candlestick/line chart component using TradingView Lightweight Charts.
 * Fetches data from the history API and displays it as a chart.
 */
export default function CandlestickChart({
  symbol,
  interval = 'minute',
  date,
  height,
  showTypeToggle = true,
  liveTick,
}: CandlestickChartProps) {
  const { isDark } = useDarkMode();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick' | 'Line'> | null>(null);
  const timeToCandleRef = useRef<Map<number, OHLCCandle>>(new Map());
  const [chartHeight, setChartHeight] = useState(height || 400);

  const [candles, setCandles] = useState<OHLCCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartType, setChartType] = useState<ChartType>('candlestick');
  const [selectedInterval, setSelectedInterval] = useState<HistoryInterval>(interval);
  const [hoveredData, setHoveredData] = useState<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);

  // Available timeframe options
  const timeframeOptions: { value: HistoryInterval; label: string }[] = [
    { value: 'minute', label: '1 Min' },
    { value: '3minute', label: '3 Min' },
    { value: '5minute', label: '5 Min' },
    { value: '10minute', label: '10 Min' },
    { value: '15minute', label: '15 Min' },
    { value: '30minute', label: '30 Min' },
    { value: '60minute', label: '1 Hour' },
    { value: 'day', label: '1 Day' },
  ];

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

  // Stabilize date strings to prevent re-fetching
  const { fromDateStr, toDateStr } = (() => {
    const toDate = date || new Date();
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - 7);

    const formatDate = (d: Date) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    return {
      fromDateStr: formatDate(fromDate),
      toDateStr: formatDate(toDate),
    };
  })();

  // Fetch history function
  const fetchHistory = useCallback(async (showLoading = true) => {
    if (!symbol) return;

    if (showLoading) {
      setLoading(true);
    }
    setError(null);

    try {
      const params = {
        symbol,
        from: `${fromDateStr} 00:00:00`,
        to: `${toDateStr} 23:59:59`,
        interval: selectedInterval,
      };

      // Use straddle history API for S- symbols
      const isStraddleSymbol = symbol.includes(':S-');
      const response = isStraddleSymbol
        ? await mdHistoryApi.getStraddleHistory(params)
        : await mdHistoryApi.getHistory(params);

      // Filter out candles with null/undefined/NaN OHLC values, then sort ascending
      const valid = response.filter((c: OHLCCandle) =>
        c.timestamp != null && c.open != null && c.high != null && c.low != null && c.close != null &&
        isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close)
      );
      const sorted = valid.sort((a, b) => a.timestamp - b.timestamp);
      setCandles(sorted);
    } catch (err) {
      console.error('Failed to fetch history:', err);
      if (showLoading) {
        setError('Failed to load chart data');
      }
    } finally {
      setLoading(false);
    }
  }, [symbol, selectedInterval, fromDateStr, toDateStr]);

  // Initial fetch
  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // XTS timestamps are already IST epoch — no offset needed
  const timezoneOffsetSeconds = 0;

  // Track previous chartType to detect changes
  const prevChartTypeRef = useRef<ChartType>(chartType);

  // Clear chart when interval changes (before new data loads)
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    }
  }, [selectedInterval]);

  // Create and update chart
  useEffect(() => {
    if (!chartContainerRef.current || loading || candles.length === 0) {
      return;
    }

    const chartTypeChanged = prevChartTypeRef.current !== chartType;
    prevChartTypeRef.current = chartType;

    // Recreate chart if it doesn't exist or chartType changed
    if (!chartRef.current || chartTypeChanged) {
      // Clean up existing chart
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        seriesRef.current = null;
      }

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

      // Create series based on chart type
      let series: any;
      if (chartType === 'candlestick') {
        series = chart.addSeries(CandlestickSeries, {
          upColor: '#26a69a',
          downColor: '#ef5350',
          borderDownColor: '#ef5350',
          borderUpColor: '#26a69a',
          wickDownColor: '#ef5350',
          wickUpColor: '#26a69a',
        });
      } else {
        series = chart.addSeries(LineSeries, {
          color: '#2962FF',
          lineWidth: 2,
        });
      }
      seriesRef.current = series;

      // Subscribe to crosshair move for OHLC legend
      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.seriesData.has(series)) {
          setHoveredData(null);
          return;
        }

        const candle = timeToCandleRef.current.get(param.time as number);
        if (candle) {
          const time = new Date(candle.timestamp).toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          setHoveredData({
            time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
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

      const cleanup = () => {
        resizeObserver.disconnect();
        window.removeEventListener('resize', handleResize);
      };

      (chartRef.current as any)._cleanup = cleanup;
    }

    // Update the time-to-candle map for crosshair lookup
    timeToCandleRef.current.clear();
    candles.forEach(candle => {
      const adjustedTime = Math.floor(candle.timestamp / 1000) + timezoneOffsetSeconds;
      timeToCandleRef.current.set(adjustedTime, candle);
    });

    // Update series data
    if (seriesRef.current) {
      // Deduplicate by time — lightweight-charts throws on duplicate timestamps
      const deduped = new Map<number, OHLCCandle>();
      for (const candle of candles) {
        const t = Math.floor(candle.timestamp / 1000) + timezoneOffsetSeconds;
        deduped.set(t, candle); // last candle per time wins
      }
      const uniqueCandles = Array.from(deduped.entries()).sort((a, b) => a[0] - b[0]);

      if (chartType === 'candlestick') {
        const candlestickData = uniqueCandles.map(([t, candle]) => ({
          time: t as any,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        }));
        seriesRef.current.setData(candlestickData);
      } else {
        const lineData = uniqueCandles.map(([t, candle]) => ({
          time: t as any,
          value: candle.close,
        }));
        seriesRef.current.setData(lineData);
      }
    }

    return () => {
      // Only cleanup on unmount, not on every candles change
    };
  }, [loading, chartHeight, chartType, candles, timezoneOffsetSeconds, isDark]);

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
      seriesRef.current = null;
    };
  }, []);

  // Get interval duration in milliseconds
  const getIntervalMs = useCallback((interval: HistoryInterval): number => {
    switch (interval) {
      case 'minute': return 60 * 1000;
      case '3minute': return 3 * 60 * 1000;
      case '5minute': return 5 * 60 * 1000;
      case '10minute': return 10 * 60 * 1000;
      case '15minute': return 15 * 60 * 1000;
      case '30minute': return 30 * 60 * 1000;
      case '60minute': return 60 * 60 * 1000;
      case 'day': return 24 * 60 * 60 * 1000;
      default: return 60 * 1000;
    }
  }, []);

  // Calculate the candle start time for a given timestamp and interval
  const getCandleStartTime = useCallback((timestamp: number, intervalMs: number): number => {
    return Math.floor(timestamp / intervalMs) * intervalMs;
  }, []);

  // Track live candle state with the interval it belongs to
  const liveCandleRef = useRef<{
    interval: HistoryInterval;
    candleStartTimeMs: number;
    chartTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);

  // Track last known candle from API to detect when server updates it
  const lastApiCandleRef = useRef<{
    timestamp: number;
    close: number;
  } | null>(null);

  // Reset live candle state when interval changes
  useEffect(() => {
    liveCandleRef.current = null;
    lastApiCandleRef.current = null;
  }, [selectedInterval]);

  // Update live candle in real-time from WebSocket ticks
  useEffect(() => {
    if (!liveTick || !seriesRef.current || candles.length === 0 || loading) return;

    const price = liveTick.price;
    const tickTime = liveTick.timestamp;
    const intervalMs = getIntervalMs(selectedInterval);
    const tzOffsetSeconds = new Date().getTimezoneOffset() * -60;

    const tickCandleStartMs = getCandleStartTime(tickTime, intervalMs);

    const lastApiCandle = candles[candles.length - 1];
    const lastApiCandleStartMs = getCandleStartTime(lastApiCandle.timestamp, intervalMs);
    const lastApiCandleChartTime = Math.floor(lastApiCandle.timestamp / 1000) + tzOffsetSeconds;

    if (tickCandleStartMs < lastApiCandleStartMs) {
      return;
    }

    const apiCandleChanged = !lastApiCandleRef.current ||
      lastApiCandleRef.current.timestamp !== lastApiCandle.timestamp ||
      lastApiCandleRef.current.close !== lastApiCandle.close;

    if (apiCandleChanged) {
      lastApiCandleRef.current = {
        timestamp: lastApiCandle.timestamp,
        close: lastApiCandle.close,
      };
    }

    if (tickCandleStartMs === lastApiCandleStartMs) {
      let baseCandle = {
        open: lastApiCandle.open,
        high: lastApiCandle.high,
        low: lastApiCandle.low,
        close: lastApiCandle.close,
      };

      if (liveCandleRef.current &&
          liveCandleRef.current.interval === selectedInterval &&
          liveCandleRef.current.candleStartTimeMs === tickCandleStartMs) {
        baseCandle = {
          open: lastApiCandle.open,
          high: Math.max(lastApiCandle.high, liveCandleRef.current.high, price),
          low: Math.min(lastApiCandle.low, liveCandleRef.current.low, price),
          close: price,
        };
      } else {
        baseCandle = {
          open: lastApiCandle.open,
          high: Math.max(lastApiCandle.high, price),
          low: Math.min(lastApiCandle.low, price),
          close: price,
        };
      }

      liveCandleRef.current = {
        interval: selectedInterval,
        candleStartTimeMs: tickCandleStartMs,
        chartTime: lastApiCandleChartTime,
        ...baseCandle,
      };

      try {
        if (chartType === 'candlestick') {
          seriesRef.current.update({
            time: lastApiCandleChartTime as any,
            open: baseCandle.open,
            high: baseCandle.high,
            low: baseCandle.low,
            close: baseCandle.close,
          });
        } else {
          seriesRef.current.update({
            time: lastApiCandleChartTime as any,
            value: baseCandle.close,
          });
        }
      } catch {
        // Ignore update errors during timeframe transitions
      }
    } else if (tickCandleStartMs > lastApiCandleStartMs) {
      const newCandleChartTime = Math.floor(tickCandleStartMs / 1000) + tzOffsetSeconds;

      if (liveCandleRef.current &&
          liveCandleRef.current.interval === selectedInterval &&
          liveCandleRef.current.candleStartTimeMs === tickCandleStartMs) {
        liveCandleRef.current = {
          ...liveCandleRef.current,
          high: Math.max(liveCandleRef.current.high, price),
          low: Math.min(liveCandleRef.current.low, price),
          close: price,
        };
      } else {
        liveCandleRef.current = {
          interval: selectedInterval,
          candleStartTimeMs: tickCandleStartMs,
          chartTime: newCandleChartTime,
          open: price,
          high: price,
          low: price,
          close: price,
        };
      }

      try {
        if (chartType === 'candlestick') {
          seriesRef.current.update({
            time: newCandleChartTime as any,
            open: liveCandleRef.current.open,
            high: liveCandleRef.current.high,
            low: liveCandleRef.current.low,
            close: liveCandleRef.current.close,
          });
        } else {
          seriesRef.current.update({
            time: newCandleChartTime as any,
            value: liveCandleRef.current.close,
          });
        }
      } catch {
        // Ignore update errors during timeframe transitions
      }
    }
  }, [liveTick, candles, chartType, selectedInterval, loading, getIntervalMs, getCandleStartTime]);

  // Auto-refresh at interval boundaries
  useEffect(() => {
    if (!symbol) return;

    const intervalMinutes = getIntervalMs(selectedInterval) / 60000;

    const getMillisUntilNextInterval = () => {
      const now = new Date();
      const currentMinute = now.getMinutes();
      const currentSecond = now.getSeconds();
      const currentMs = now.getMilliseconds();

      const minutesIntoInterval = currentMinute % intervalMinutes;
      const minutesUntilNext = intervalMinutes - minutesIntoInterval;

      const msUntilNextMinute = ((minutesUntilNext - 1) * 60 + (60 - currentSecond)) * 1000 - currentMs;
      return msUntilNextMinute + 3000;
    };

    let timeoutId: ReturnType<typeof setTimeout>;

    const scheduleNextRefresh = () => {
      const msUntilNext = getMillisUntilNextInterval();
      timeoutId = setTimeout(() => {
        fetchHistory(false);
        scheduleNextRefresh();
      }, msUntilNext);
    };

    let minuteIntervalId: ReturnType<typeof setTimeout> | undefined;
    if (intervalMinutes > 1) {
      const scheduleMinuteRefresh = () => {
        const now = new Date();
        const secondsRemaining = 60 - now.getSeconds();
        const msRemaining = (secondsRemaining * 1000) - now.getMilliseconds() + 2000;
        minuteIntervalId = setTimeout(() => {
          fetchHistory(false);
          scheduleMinuteRefresh();
        }, msRemaining);
      };
      scheduleMinuteRefresh();
    }

    scheduleNextRefresh();

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (minuteIntervalId) {
        clearTimeout(minuteIntervalId);
      }
    };
  }, [symbol, selectedInterval, fetchHistory, getIntervalMs]);

  if (loading) {
    return (
      <div
        ref={containerRef}
        className="flex items-center justify-center h-full"
      >
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

  if (candles.length === 0) {
    return (
      <div
        ref={containerRef}
        className="flex flex-col items-center justify-center text-ink-soft h-full"
      >
        <BsGraphUp style={{ fontSize: '3rem' }} />
        <p className="mt-4">No chart data available</p>
      </div>
    );
  }

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

  return (
    <div ref={containerRef} className="flex flex-col h-full p-4">
      {showTypeToggle && (
        <div className="flex justify-between items-center mb-2 shrink-0">
          <div className="flex items-center gap-4">
            <small className="text-ink-soft">
              {candles.length} data points
            </small>
            {hoveredData && (
              <div className="flex items-center gap-2 font-mono" style={{ fontSize: '0.8rem' }}>
                <span className="text-ink-soft">{hoveredData.time}</span>
                <span>O: <strong>{hoveredData.open.toFixed(2)}</strong></span>
                <span>H: <strong className="text-success-500 dark:text-success-400">{hoveredData.high.toFixed(2)}</strong></span>
                <span>L: <strong className="text-danger-600 dark:text-danger-400">{hoveredData.low.toFixed(2)}</strong></span>
                <span>C: <strong className={hoveredData.close >= hoveredData.open ? 'text-success-500 dark:text-success-400' : 'text-danger-600 dark:text-danger-400'}>{hoveredData.close.toFixed(2)}</strong></span>
              </div>
            )}
          </div>
          <div className="flex gap-2 items-center">
            {/* Timeframe Dropdown */}
            <select
              className="w-full rounded border border-hairline bg-card px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60 disabled:bg-raised disabled:opacity-70 py-1 text-xs"
              style={{ width: '90px' }}
              value={selectedInterval}
              onChange={(e) => setSelectedInterval(e.target.value as HistoryInterval)}
            >
              {timeframeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {/* Navigation Controls */}
            <div className="inline-flex [&>button]:rounded-none [&>button]:-ml-px [&>*:first-child]:rounded-l [&>*:first-child]:ml-0 [&>*:last-child]:rounded-r">
              <button
                className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm"
                onClick={handleScrollLeft}
                title="Scroll Left"
              >
                <BsChevronLeft />
              </button>
              <button
                className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm"
                onClick={handleZoomOut}
                title="Zoom Out"
              >
                <BsDash />
              </button>
              <button
                className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm"
                onClick={handleResetZoom}
                title="Reset Zoom"
              >
                <BsArrowsAngleExpand />
              </button>
              <button
                className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm"
                onClick={handleZoomIn}
                title="Zoom In"
              >
                <BsPlus />
              </button>
              <button
                className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-hairline text-ink hover:bg-raised px-3.5 py-1.5 text-sm"
                onClick={handleScrollRight}
                title="Scroll Right"
              >
                <BsChevronRight />
              </button>
            </div>
            {/* Chart Type Toggle */}
            <div className="inline-flex [&>button]:rounded-none [&>button]:-ml-px [&>*:first-child]:rounded-l [&>*:first-child]:ml-0 [&>*:last-child]:rounded-r">
              <button
                className={`inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 px-2.5 py-1 text-xs ${chartType === 'candlestick' ? 'bg-primary-600 text-white hover:bg-primary-700' : 'border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10'}`}
                onClick={() => setChartType('candlestick')}
                title="Candlestick Chart"
              >
                <BsBarChart />
              </button>
              <button
                className={`inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 px-2.5 py-1 text-xs ${chartType === 'line' ? 'bg-primary-600 text-white hover:bg-primary-700' : 'border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10'}`}
                onClick={() => setChartType('line')}
                title="Line Chart"
              >
                <BsGraphUp />
              </button>
            </div>
          </div>
        </div>
      )}
      <div ref={chartContainerRef} className="grow" style={{ width: '100%', minHeight: 0 }} />
    </div>
  );
}
