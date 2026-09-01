/**
 * OverallSummary Component
 * Shows aggregated strategy and risk profile summaries across all users
 */

import React, { useMemo, useState, useEffect, useRef } from 'react';
import { BsPieChart, BsGraphUp } from 'react-icons/bs';
import { Badge, Drawer, Spinner } from '@/components/ui';

import type { UserTradeSummary, StrategySummary, TerminalBreakdown } from '@/types/terminal';
import { terminalService } from '@/services/terminal/terminalService';
import { usePermissions } from '@/hooks/usePermissions';
import PnLDisplay from './PnLDisplay';
import RiskProfileChart from './RiskProfileChart';
import { valueForMode, countForMode, type TradingMode } from '@/utils/tradingMode';
import { productBadgeTone } from '@/types/product';

interface AggregatedStrategy {
  strategy: string;
  displayName: string;
  product: string;
  userCount: number;
  activeTradesCount: number;
  completedTradesCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  charges: number;
  netPnl: number;
  allocatedCapital: number;
  returnsPercent: number;
}

interface OverallSummaryProps {
  summaries: UserTradeSummary[];
  show: boolean;
  onHide: () => void;
  /** Which single section this panel renders — Strategy Summary and Risk Profile are now separate
   *  side panels so each can be permission-gated (STRATEGY_SUMMARIES vs RISK_PROFILES) independently. */
  section: 'strategy' | 'risk';
  tradingMode?: TradingMode;
}

const OverallSummary: React.FC<OverallSummaryProps> = ({
  summaries,
  show,
  onHide,
  section,
  tradingMode = 'live',
}) => {
  // Algo-only risk (no broker) when the viewer lacks ALGO_BROKER_COMPARE.
  const { algoBrokerCompare } = usePermissions();
  const algoOnlyRisk = !algoBrokerCompare.canView;
  // Strategy summaries + risk profiles no longer ride on the summary broadcast — fetch the
  // breakdown for the currently-viewed user-brokers once when the modal opens.
  const [breakdowns, setBreakdowns] = useState<TerminalBreakdown[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const summariesRef = useRef(summaries);
  summariesRef.current = summaries;

  useEffect(() => {
    if (!show) return;
    const userBrokers = summariesRef.current.map(s => ({ username: s.username, broker: s.broker }));
    if (userBrokers.length === 0) {
      setBreakdowns([]);
      return;
    }
    setLoading(true);
    setLoadError(null);
    terminalService.getOverallBreakdown(userBrokers)
      .then(setBreakdowns)
      .catch((e) => setLoadError(
        (e && typeof e === 'object' && 'message' in e) ? String((e as { message?: string }).message) : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [show]);

  // Aggregate strategies across all users (from the fetched breakdowns)
  const aggregatedStrategies = useMemo(() => {
    const strategyMap = new Map<string, AggregatedStrategy>();

    breakdowns.forEach(breakdown => {
      if (!breakdown.strategySummaries) return;

      Object.values(breakdown.strategySummaries).forEach((strat: StrategySummary) => {
        // Mode-adjusted per-strategy values (live = total - paper).
        const active = countForMode(strat.activeTradesCount, strat.paperActiveTradesCount, tradingMode);
        const completed = countForMode(strat.completedTradesCount, strat.paperCompletedTradesCount, tradingMode);
        const realized = valueForMode(strat.realizedPnl, strat.paperRealizedPnl, tradingMode);
        const unrealized = valueForMode(strat.unrealizedPnl, strat.paperUnrealizedPnl, tradingMode);
        const total = valueForMode(strat.totalPnl, strat.paperTotalPnl, tradingMode);
        const charges = valueForMode(strat.charges, strat.paperCharges, tradingMode);
        const net = valueForMode(strat.netPnl ?? (strat.totalPnl - (strat.charges || 0)), strat.paperNetPnl, tradingMode);
        const capital = strat.allocatedCapital || 0;

        const existing = strategyMap.get(strat.strategy);
        if (existing) {
          existing.userCount += 1;
          existing.activeTradesCount += active;
          existing.completedTradesCount += completed;
          existing.realizedPnl += realized;
          existing.unrealizedPnl += unrealized;
          existing.totalPnl += total;
          existing.charges += charges;
          existing.netPnl += net;
          existing.allocatedCapital += capital;
        } else {
          strategyMap.set(strat.strategy, {
            strategy: strat.strategy,
            displayName: strat.displayName || strat.strategy,
            product: strat.product || '-',
            userCount: 1,
            activeTradesCount: active,
            completedTradesCount: completed,
            realizedPnl: realized,
            unrealizedPnl: unrealized,
            totalPnl: total,
            charges: charges,
            netPnl: net,
            allocatedCapital: capital,
            returnsPercent: 0,
          });
        }
      });
    });

    // Calculate returns percent for each strategy
    const result = Array.from(strategyMap.values());
    result.forEach(strat => {
      if (strat.allocatedCapital > 0) {
        strat.returnsPercent = (strat.netPnl / strat.allocatedCapital) * 100;
      }
    });

    // Sort by total P&L descending
    result.sort((a, b) => b.totalPnl - a.totalPnl);

    return result;
  }, [breakdowns, tradingMode]);

  // Aggregate risk profile across all users (both algo and broker)
  const { aggregatedRiskProfile, aggregatedBrokerRiskProfile } = useMemo(() => {
    const algoRiskMap = new Map<string, number>();
    const brokerRiskMap = new Map<string, number>();

    // Risk profiles come from the fetched breakdowns (live = total - paper, per movement bucket).
    breakdowns.forEach(breakdown => {
      if (breakdown.riskProfile) {
        Object.entries(breakdown.riskProfile).forEach(([key, value]) => {
          const paperVal = breakdown.paperRiskProfile?.[key];
          const existing = algoRiskMap.get(key) || 0;
          algoRiskMap.set(key, existing + valueForMode(value, paperVal, tradingMode));
        });
      }
      if (breakdown.brokerRiskProfile) {
        Object.entries(breakdown.brokerRiskProfile).forEach(([key, value]) => {
          const paperVal = breakdown.paperBrokerRiskProfile?.[key];
          const existing = brokerRiskMap.get(key) || 0;
          brokerRiskMap.set(key, existing + valueForMode(value, paperVal, tradingMode));
        });
      }
    });

    const algoResult: Record<string, number> = {};
    algoRiskMap.forEach((value, key) => { algoResult[key] = value; });
    const brokerResult: Record<string, number> = {};
    brokerRiskMap.forEach((value, key) => { brokerResult[key] = value; });

    return { aggregatedRiskProfile: algoResult, aggregatedBrokerRiskProfile: brokerResult };
  }, [breakdowns, tradingMode]);

  // Capital is still on the summary (not moved); aggregate it from the rows in view.
  const { totalAlgoCapital, totalExternalCapital } = useMemo(() => {
    let algoCapital = 0;
    let extCapital = 0;
    summaries.forEach(summary => {
      algoCapital += summary.totalCapital || 0;
      extCapital += summary.externalCapital || 0;
    });
    return { totalAlgoCapital: algoCapital, totalExternalCapital: extCapital };
  }, [summaries]);

  // Calculate totals for strategy table
  const strategyTotals = useMemo(() => {
    return aggregatedStrategies.reduce(
      (acc, strat) => ({
        userCount: acc.userCount + strat.userCount,
        activeTradesCount: acc.activeTradesCount + strat.activeTradesCount,
        completedTradesCount: acc.completedTradesCount + strat.completedTradesCount,
        realizedPnl: acc.realizedPnl + strat.realizedPnl,
        unrealizedPnl: acc.unrealizedPnl + strat.unrealizedPnl,
        totalPnl: acc.totalPnl + strat.totalPnl,
        charges: acc.charges + strat.charges,
        netPnl: acc.netPnl + strat.netPnl,
        allocatedCapital: acc.allocatedCapital + strat.allocatedCapital,
      }),
      {
        userCount: 0,
        activeTradesCount: 0,
        completedTradesCount: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
        charges: 0,
        netPnl: 0,
        allocatedCapital: 0,
      }
    );
  }, [aggregatedStrategies]);

  const cell = 'px-2 py-1.5';
  const loadingEl = (
    <div className="py-10 text-center text-primary-500">
      <Spinner />
    </div>
  );
  const errorEl = <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">{loadError}</div>;

  return (
    <Drawer
      open={show}
      onClose={onHide}
      width="910px"
      title={
        <span className="flex items-center gap-2">
          {section === 'strategy' ? <BsPieChart /> : <BsGraphUp />}
          {section === 'strategy' ? 'Strategy Summary' : 'Risk Profile'}
        </span>
      }
    >
      {section === 'strategy' ? (
        loading ? (
          loadingEl
        ) : loadError ? (
          errorEl
        ) : aggregatedStrategies.length === 0 ? (
          <div className="py-10 text-center text-ink-soft">No strategy data available</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`}>Strategy</th>
                  <th className={`${cell} text-center`}>Product</th>
                  <th className={`${cell} text-center`}>Users</th>
                  <th className={`${cell} text-center`}>Active</th>
                  <th className={`${cell} text-center`}>Done</th>
                  <th className={`${cell} text-right`}>Realized</th>
                  <th className={`${cell} text-right`}>Unrealized</th>
                  <th className={`${cell} text-right`}>Total P&L</th>
                  <th className={`${cell} text-right`}>Net P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {aggregatedStrategies.map((strat) => (
                  <tr key={strat.strategy} className="hover:bg-raised/50">
                    <td className={`${cell} font-medium text-ink`}>{strat.displayName}</td>
                    <td className={`${cell} text-center`}>
                      <Badge tone={productBadgeTone(strat.product)}>{strat.product}</Badge>
                    </td>
                    <td className={`${cell} text-center`}>
                      <Badge tone="info">{strat.userCount}</Badge>
                    </td>
                    <td className={`${cell} text-center`}>{strat.activeTradesCount > 0 ? <Badge tone="blue">{strat.activeTradesCount}</Badge> : <span className="text-ink-faint">0</span>}</td>
                    <td className={`${cell} text-center`}>{strat.completedTradesCount > 0 ? <Badge tone="success">{strat.completedTradesCount}</Badge> : <span className="text-ink-faint">0</span>}</td>
                    <td className={`${cell} text-right`}>
                      <PnLDisplay value={strat.realizedPnl} size="sm" fullFormat />
                    </td>
                    <td className={`${cell} text-right`}>
                      <PnLDisplay value={strat.unrealizedPnl} size="sm" fullFormat />
                    </td>
                    <td className={`${cell} text-right`}>
                      <PnLDisplay value={strat.totalPnl} fullFormat />
                    </td>
                    <td className={`${cell} text-right`}>
                      <PnLDisplay value={strat.netPnl} fullFormat />
                      <small className="block text-ink-faint">Chg: {strat.charges.toLocaleString('en-IN')}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-raised font-bold">
                <tr>
                  <td className={cell}>Total ({aggregatedStrategies.length} strategies)</td>
                  <td></td>
                  <td className={`${cell} text-center`}>
                    <Badge tone="info">{summaries.length}</Badge>
                  </td>
                  <td className={`${cell} text-center`}>
                    <Badge tone="blue">{strategyTotals.activeTradesCount}</Badge>
                  </td>
                  <td className={`${cell} text-center`}>
                    <Badge tone="success">{strategyTotals.completedTradesCount}</Badge>
                  </td>
                  <td className={`${cell} text-right`}>
                    <PnLDisplay value={strategyTotals.realizedPnl} fullFormat />
                  </td>
                  <td className={`${cell} text-right`}>
                    <PnLDisplay value={strategyTotals.unrealizedPnl} fullFormat />
                  </td>
                  <td className={`${cell} text-right`}>
                    <PnLDisplay value={strategyTotals.totalPnl} size="lg" fullFormat />
                  </td>
                  <td className={`${cell} text-right`}>
                    <PnLDisplay value={strategyTotals.netPnl} size="lg" fullFormat />
                    <small className="block text-ink-faint">Chg: {strategyTotals.charges.toLocaleString('en-IN')}</small>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      ) : loading ? (
        loadingEl
      ) : loadError ? (
        errorEl
      ) : Object.keys(aggregatedRiskProfile).length === 0 && Object.keys(aggregatedBrokerRiskProfile).length === 0 ? (
        <div className="py-10 text-center text-ink-soft">No risk profile data available</div>
      ) : (
        <div>
          <div className="mb-3">
            <small className="text-ink-soft">Combined P&L at different index movement levels across {summaries.length} users</small>
          </div>
          <RiskProfileChart
            riskProfile={aggregatedRiskProfile}
            brokerRiskProfile={aggregatedBrokerRiskProfile}
            algoCapital={totalAlgoCapital}
            externalCapital={totalExternalCapital}
            height={250}
            algoOnly={algoOnlyRisk}
          />
        </div>
      )}
    </Drawer>
  );
};

export default OverallSummary;
