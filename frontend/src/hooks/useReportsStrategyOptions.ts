import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { strategyCatalogService } from '@/services/admin/strategyEngineService';
import { eodPnlService } from '@/services/admin/v2AdminService';

export interface ReportsStrategyOption {
  strategyName: string;
  displayName: string;
  product?: string;
}

/**
 * Strategy options for the P&L Reports filters (Trades + EOD PnL tabs).
 *
 * Unions two sources, both scoped to the caller:
 *  1. the active strategy CATALOG (SYSTEM-scope, with display names + product), and
 *  2. the distinct (strategyName, product) actually present in the caller's EOD reports.
 *
 * (2) covers strategies that have since been DISABLED or REMOVED — they're gone from the catalog but
 * still appear in historical reports, so without this you couldn't filter by them. A report-only
 * strategy has no catalog entry, so its display name falls back to the raw strategy name. QUANT-188.
 */
export function useReportsStrategyOptions(): ReportsStrategyOption[] {
  const { data: catalog } = useQuery({
    queryKey: ['strategy-catalog'],
    queryFn: () => strategyCatalogService.getOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const { data: reportStrategies } = useQuery({
    queryKey: ['reports', 'eod-strategies'],
    queryFn: () => eodPnlService.getReportStrategies(),
    staleTime: 5 * 60 * 1000,
  });

  return useMemo(() => {
    // Display name is per-strategy: a catalog strategy keeps its display name across all its product
    // rows; a report-only strategy falls back to its raw name.
    const displayByName = new Map<string, string>();
    (catalog || []).forEach((s) => displayByName.set(s.strategyName, s.displayName || s.strategyName));

    const byKey = new Map<string, ReportsStrategyOption>();
    const add = (strategyName: string, product?: string | null) => {
      if (!strategyName) return;
      const key = `${strategyName}|${product || ''}`;
      if (!byKey.has(key)) {
        byKey.set(key, { strategyName, displayName: displayByName.get(strategyName) || strategyName, product: product || undefined });
      }
    };

    (catalog || []).forEach((s) => add(s.strategyName, s.product));
    (reportStrategies || []).forEach((s) => add(s.strategyName, s.product));

    return Array.from(byKey.values());
  }, [catalog, reportStrategies]);
}
