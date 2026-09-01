/**
 * Utility functions for formatting values
 */

/**
 * Format a number in Indian numbering system (e.g., 1,23,45,678).
 *
 * For values >= 100 crore the result switches to compact crore notation
 * (`100.00 Cr`, `172.35 Cr`, `4320.78 Cr`) — the locale default
 * (`1,00,00,00,000`) gets unwieldy at that scale.
 *
 * Below 100 crore, behaviour is standard `en-IN` grouping
 * (1,23,45,678 / 99,00,00,000).
 */
export const formatIndianNumber = (value: number | undefined | null, removeDecimals = true): string => {
  if (value === undefined || value === null || isNaN(value)) {
    return '-';
  }

  const num = removeDecimals ? Math.round(value) : value;
  const abs = Math.abs(num);

  if (abs >= 1e9) {
    // 100 crore and above — divide by 1 Cr, format the crore-value with
    // standard Indian grouping, suffix " Cr". Decimals are only shown
    // when the crore-value isn't a clean integer (so 4,320 Cr but
    // 172.35 Cr; 100 Cr but 100.55 Cr).
    const sign = num < 0 ? '-' : '';
    const crores = abs / 1e7;
    const formatted = Number.isInteger(crores)
      ? crores.toLocaleString('en-IN')
      : crores.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${sign}${formatted} Cr`;
  }

  return num.toLocaleString('en-IN');
};

/**
 * Format currency in Indian format with optional currency symbol
 * @param value - The number to format
 * @param symbol - Currency symbol (default: '₹')
 * @param removeDecimals - Whether to round and remove decimal places (default: true)
 * @returns Formatted currency string
 */
export const formatIndianCurrency = (value: number | undefined | null, symbol = '₹', removeDecimals = true): string => {
  if (value === undefined || value === null || isNaN(value)) {
    return '-';
  }

  return `${symbol}${formatIndianNumber(value, removeDecimals)}`;
};

/**
 * Format currency (alias for formatIndianCurrency)
 * @param value - The number to format
 * @param symbol - Currency symbol (default: '₹')
 * @returns Formatted currency string
 */
export const formatCurrency = (value: number | undefined | null, symbol = '₹'): string => {
  return formatIndianCurrency(value, symbol, true);
};

/**
 * Compact Indian-number abbreviation (1.23 Cr / 45.67 L / 12.34 K).
 * Used on chart axes / inline tile values where ₹1,23,45,67,890 would
 * be too wide. For numbers below 1000, formats with the standard Indian
 * grouping (no abbreviation). Negatives are handled.
 */
export const formatIndianCompact = (value: number | undefined | null, decimals = 2): string => {
  if (value === undefined || value === null || isNaN(value)) {
    return '-';
  }
  const sign = value < 0 ? '-' : '';
  const n = Math.abs(value);
  const stripTrail = (s: string) => s.replace(/\.?0+$/, '');
  if (n >= 1e7) return `${sign}${stripTrail((n / 1e7).toFixed(decimals))} Cr`;
  if (n >= 1e5) return `${sign}${stripTrail((n / 1e5).toFixed(decimals))} L`;
  if (n >= 1e3) return `${sign}${stripTrail((n / 1e3).toFixed(decimals))} K`;
  return `${sign}${formatIndianNumber(n, true)}`;
};

/**
 * Format a number with specified decimal places
 * @param value - The number to format
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted number string
 */
export const formatNumber = (value: number | undefined | null, decimals = 2): string => {
  if (value === undefined || value === null || isNaN(value)) {
    return '-';
  }

  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

/**
 * Format a percentage value
 * @param value - The number to format (already in percentage form, e.g., 50 for 50%)
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted percentage string
 */
export const formatPercent = (value: number | undefined | null, decimals = 2): string => {
  if (value === undefined || value === null || isNaN(value)) {
    return '-';
  }

  return `${formatNumber(value, decimals)}%`;
};

/**
 * Strategy display order mapping - should be updated with actual strategy config
 */
const strategyDisplayOrderMap: Record<string, number> = {};

/**
 * Update strategy display order mappings from strategy configuration
 * @param strategies - Array of strategy objects with name and displayOrder
 */
export const updateStrategyDisplayOrderMappings = (
  strategies: Array<{ name: string; displayOrder?: number }>
): void => {
  strategies.forEach((s) => {
    strategyDisplayOrderMap[s.name] = s.displayOrder || 0;
  });
};

/**
 * Get strategy display order for sorting
 * @param strategyName - Name of the strategy
 * @returns Display order number
 */
export const getStrategyDisplayOrder = (strategyName: string | undefined): number => {
  if (!strategyName) return 0;
  if (strategyName === 'Total' || strategyName === 'total' || strategyName === 'All' || strategyName === 'all') {
    return 9999999;
  }
  return strategyDisplayOrderMap[strategyName] || 0;
};

/**
 * Trade interface for sorting (minimal fields needed)
 */
interface SortableTrade {
  strategy?: string;
  group?: string;
  hedgeCorrelationID?: string;
  pairTradeCorrelationID?: string;
  comboId?: string;
  tradingSymbol?: string;
  direction?: string;
  netProfitLoss?: number;
  productType?: string;
  startTimestamp?: number;
}

/**
 * Get the grouping ID for a trade. A combo id is the umbrella for the WHOLE structure
 * (a long/short pair's peer legs share no hedge/pair correlation, only the combo id;
 * a futures+hedge combo's id spans both legs the same way the hedge correlation does),
 * so it takes precedence; legacy non-combo trades keep the hedge/pair correlation.
 */
const getCorrelationID = (trade: SortableTrade): string => {
  return trade.comboId || trade.hedgeCorrelationID || trade.pairTradeCorrelationID || '';
};

/**
 * Sort trades by strategy (ordered by latest start time), then by start time within strategy
 * while keeping correlated L/S pairs together.
 * Sorting logic:
 * 1. First by strategy - ordered by latest startTimestamp within each strategy (latest first)
 * 2. Within strategy - by correlation group's latest timestamp (latest first), keeping L/S pairs together
 * 3. Within correlation - by direction (LONG before SHORT)
 * @param trades - Array of trades to sort
 * @returns Sorted array of trades
 */
export const sortTrades = <T extends SortableTrade>(trades: T[]): T[] => {
  if (!trades || trades.length === 0) return trades;

  // Build a map of strategy -> latest startTimestamp
  const strategyLatestTime = new Map<string, number>();
  for (const trade of trades) {
    const strategy = trade.strategy || '';
    const timestamp = trade.startTimestamp || 0;
    const current = strategyLatestTime.get(strategy) || 0;
    if (timestamp > current) {
      strategyLatestTime.set(strategy, timestamp);
    }
  }

  // Build a map of correlationID -> latest startTimestamp (for keeping L/S pairs together)
  const correlationLatestTime = new Map<string, number>();
  for (const trade of trades) {
    const corrId = getCorrelationID(trade);
    if (corrId) {
      const timestamp = trade.startTimestamp || 0;
      const current = correlationLatestTime.get(corrId) || 0;
      if (timestamp > current) {
        correlationLatestTime.set(corrId, timestamp);
      }
    }
  }

  return [...trades].sort((t1, t2) => {
    // Sort by strategy - ordered by latest startTimestamp (descending)
    const strategy1 = t1.strategy || '';
    const strategy2 = t2.strategy || '';
    if (strategy1 !== strategy2) {
      const latestTime1 = strategyLatestTime.get(strategy1) || 0;
      const latestTime2 = strategyLatestTime.get(strategy2) || 0;
      if (latestTime1 !== latestTime2) {
        return latestTime2 - latestTime1; // Latest first
      }
      // Same latest time - sort by strategy name alphabetically
      return strategy1.localeCompare(strategy2);
    }

    // Within same strategy - check if trades are correlated (L/S pairs)
    const corr1 = getCorrelationID(t1);
    const corr2 = getCorrelationID(t2);

    // If both have same correlation ID, keep them together and sort by direction
    if (corr1 && corr2 && corr1 === corr2) {
      // Same correlation/combo - sort by direction (LONG before SHORT), then by symbol so
      // multi-leg combos with same-direction legs order deterministically
      const dir1 = t1.direction || '';
      const dir2 = t2.direction || '';
      if (dir1 !== dir2) {
        return dir1.localeCompare(dir2);
      }
      return (t1.tradingSymbol || '').localeCompare(t2.tradingSymbol || '');
    }

    // Different correlations or no correlation - sort by timestamp (latest first)
    // Use correlation's latest time if correlated, otherwise use trade's own time
    const time1 = corr1 ? (correlationLatestTime.get(corr1) || 0) : (t1.startTimestamp || 0);
    const time2 = corr2 ? (correlationLatestTime.get(corr2) || 0) : (t2.startTimestamp || 0);
    if (time1 !== time2) {
      return time2 - time1; // Latest first
    }

    // Same time - sort by direction (LONG before SHORT)
    const dir1 = t1.direction || '';
    const dir2 = t2.direction || '';
    return dir1.localeCompare(dir2);
  });
};

/**
 * Trade signal interface for sorting (minimal fields needed)
 */
interface SortableTradeSignal {
  strategy?: string;
  group?: string;
  hedgeCorrelationID?: string;
  direction?: string;
  signalGenerationTime?: number;
}

/**
 * Sort trade signals by strategy display order, group, hedge correlation, direction, and time.
 * Sorting logic (same as sortTrades):
 * 1. First by strategy display order
 * 2. Then by group name
 * 3. Then by hedge correlation ID (keeping correlated signals together)
 * 4. Within same correlation - sort by direction (LONG before SHORT)
 * 5. Finally by signalGenerationTime (descending - latest first)
 * @param signals - Array of trade signals to sort
 * @returns Sorted array of trade signals
 */
export const sortTradeSignals = <T extends SortableTradeSignal>(signals: T[]): T[] => {
  if (!signals || signals.length === 0) return signals;

  return [...signals].sort((s1, s2) => {
    // Sort by strategy display order first
    const strategy1 = s1.strategy || '';
    const strategy2 = s2.strategy || '';
    if (strategy1 !== strategy2) {
      return getStrategyDisplayOrder(strategy1) - getStrategyDisplayOrder(strategy2);
    }

    // Then by group
    const group1 = s1.group || '';
    const group2 = s2.group || '';
    if (group1 !== group2) {
      return group1.localeCompare(group2);
    }

    // Then by hedge correlation ID (keep correlated signals together)
    if (s1.hedgeCorrelationID && s2.hedgeCorrelationID) {
      if (s1.hedgeCorrelationID !== s2.hedgeCorrelationID) {
        return s1.hedgeCorrelationID.localeCompare(s2.hedgeCorrelationID);
      } else {
        // Same correlation ID - sort by direction (LONG before SHORT)
        const dir1 = s1.direction || '';
        const dir2 = s2.direction || '';
        return dir1.localeCompare(dir2);
      }
    }

    // Finally by signalGenerationTime (descending - latest first)
    const time1 = s1.signalGenerationTime || 0;
    const time2 = s2.signalGenerationTime || 0;
    return time2 - time1;
  });
};
