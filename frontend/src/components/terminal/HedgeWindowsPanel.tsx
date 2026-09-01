/**
 * HedgeWindowsPanel Component
 * Shows hedge window schedules for POSITIONAL strategies across all exchanges.
 * Displays morning (1% -> 4%) and evening (4% -> 1%) hedge replace windows.
 * Includes hedge replace recovery status and manual recovery trigger.
 * Tailwind design system (bottom slide-over + inline collapsible accordion).
 */

import React, { useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  BsArrowClockwise,
  BsSunrise,
  BsSunset,
  BsShieldCheck,
  BsClock,
  BsCheckCircleFill,
  BsCircle,
  BsHourglassSplit,
  BsPlayFill,
  BsListUl,
  BsChevronDown,
  BsChevronRight,
  BsX,
} from 'react-icons/bs';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'react-toastify';

import HelpIcon from '@/components/common/HelpIcon';
import { terminalHelpContent } from '@/data/help/terminal-help';
import {
  engineControlService,
  hedgeReplaceService,
  strategyDefinitionService,
  type HedgeReplaceStatusItem,
  type HedgeReplaceRecoveryResult,
} from '@/services/admin/strategyEngineService';
import type { ExchangeEngineMetrics, HedgeWindowStrategy, HedgeWindow } from '@/types/strategy-engine';
import { Badge, Button, Modal, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';

interface HedgeWindowsPanelProps {
  show: boolean;
  onHide: () => void;
}

const cell = 'px-2 py-1.5';
const ctrl = 'h-9 w-full rounded-control border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';

const Tile: React.FC<{ value: React.ReactNode; label: string; tone: string; sm?: boolean }> = ({ value, label, tone, sm }) => (
  <div className="rounded-card border border-hairline bg-card py-2 text-center">
    <div className={`${sm ? 'text-lg' : 'text-2xl'} font-bold ${tone}`}>{value}</div>
    <small className="text-ink-faint">{label}</small>
  </div>
);

const Collapsible: React.FC<{ header: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }> = ({ header, defaultOpen, children }) => {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="mb-2 overflow-hidden rounded-card border border-hairline">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 bg-raised px-3 py-2 text-left text-sm">
        {open ? <BsChevronDown size={12} className="shrink-0" /> : <BsChevronRight size={12} className="shrink-0" />}
        {header}
      </button>
      {open && <div className="p-3">{children}</div>}
    </div>
  );
};

const HedgeWindowsPanel: React.FC<HedgeWindowsPanelProps> = ({ show, onHide }) => {
  const helpContent = terminalHelpContent;
  const queryClient = useQueryClient();
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [selectedWindowType, setSelectedWindowType] = useState<'MORNING' | 'EVENING'>('MORNING');
  const [selectedStrategy, setSelectedStrategy] = useState<string>('ALL');
  const [recoveryResult, setRecoveryResult] = useState<HedgeReplaceRecoveryResult | null>(null);

  const { data: allStatus, isLoading: isStatusLoading, error: statusError, refetch: refetchStatus } = useQuery({
    queryKey: ['engine-status-all'],
    queryFn: () => engineControlService.getAllStatus(),
    refetchInterval: show ? 30000 : false,
    enabled: show,
  });

  const { data: hedgeReplaceStatus, isLoading: isHedgeStatusLoading, refetch: refetchHedgeStatus } = useQuery({
    queryKey: ['hedge-replace-status'],
    queryFn: () => hedgeReplaceService.getStatus(),
    refetchInterval: show ? 15000 : false,
    enabled: show,
  });

  const { data: strategyDefinitions } = useQuery({
    queryKey: ['strategy-definitions-hedge-enabled'],
    queryFn: () => strategyDefinitionService.getAll(),
    enabled: show,
    staleTime: 60000,
  });

  const recoveryMutation = useMutation({
    mutationFn: ({ strategyName, windowType }: { strategyName: string; windowType: 'MORNING' | 'EVENING' }) => hedgeReplaceService.runRecovery(strategyName, windowType),
    onSuccess: (result) => {
      setRecoveryResult(result);
      if (result.success) toast.success(`Hedge replace completed: ${result.tradesRecovered} trades triggered/recovered`);
      else toast.warning(`Hedge replace completed with issues: ${result.message}`);
      refetchHedgeStatus();
      queryClient.invalidateQueries({ queryKey: ['hedge-replace-status'] });
    },
    onError: (error: Error) => {
      toast.error(`Hedge replace trigger/recovery failed: ${error.message}`);
    },
  });

  const runningExchanges = useMemo(() => {
    if (!allStatus?.exchanges) return [];
    return allStatus.exchanges.filter((e) => e.running).map((e) => e.exchange);
  }, [allStatus]);

  const metricsQueries = useQueries({
    queries: runningExchanges.map((exchange) => ({
      queryKey: ['engine-metrics', exchange],
      queryFn: () => engineControlService.getMetrics(exchange),
      enabled: show && runningExchanges.length > 0,
      refetchInterval: show ? 10000 : false,
    })),
  });

  const exchangeMetrics = useMemo(() => {
    const result: { exchange: string; metrics: ExchangeEngineMetrics | null; isLoading: boolean; error: Error | null }[] = [];
    runningExchanges.forEach((exchange, index) => {
      const query = metricsQueries[index];
      result.push({ exchange, metrics: query?.data ?? null, isLoading: query?.isLoading ?? false, error: (query?.error as Error) || null });
    });
    return result;
  }, [runningExchanges, metricsQueries]);

  const overallStats = useMemo(() => {
    let totalStrategies = 0;
    let morningCompleted = 0;
    let morningScheduled = 0;
    let eveningCompleted = 0;
    let eveningScheduled = 0;
    let totalExecuted = 0;
    exchangeMetrics.forEach(({ metrics }) => {
      if (!metrics?.hedges) return;
      const strategies = metrics.hedges.strategies || [];
      totalStrategies += strategies.length;
      totalExecuted += metrics.hedges.executedTasks || 0;
      strategies.forEach((s) => {
        if (s.morningWindow) {
          if (s.morningWindow.status === 'COMPLETED') morningCompleted++;
          else if (s.morningWindow.status === 'SCHEDULED') morningScheduled++;
        }
        if (s.eveningWindow) {
          if (s.eveningWindow.status === 'COMPLETED') eveningCompleted++;
          else if (s.eveningWindow.status === 'SCHEDULED') eveningScheduled++;
        }
      });
    });
    return { totalStrategies, morningCompleted, morningScheduled, eveningCompleted, eveningScheduled, totalExecuted };
  }, [exchangeMetrics]);

  const hedgeReplaceStats = useMemo(() => {
    const data = hedgeReplaceStatus?.data || [];
    return {
      total: data.length,
      pending: data.filter((d) => d.hedgeReplaceStatus === 'NEW_HEDGE_PENDING').length,
      filled: data.filter((d) => d.hedgeReplaceStatus === 'NEW_HEDGE_FILLED').length,
      exitPending: data.filter((d) => d.hedgeReplaceStatus === 'OLD_HEDGE_EXIT_PENDING').length,
      complete: data.filter((d) => d.hedgeReplaceStatus === 'COMPLETE').length,
      failed: data.filter((d) => d.hedgeReplaceStatus === 'FAILED').length,
    };
  }, [hedgeReplaceStatus]);

  const strategyList = useMemo(() => {
    if (!strategyDefinitions) return [];
    return strategyDefinitions.filter((s) => s.hedgeReplaceEnabled).map((s) => s.strategyName).sort();
  }, [strategyDefinitions]);

  const isLoading = isStatusLoading || metricsQueries.some((q) => q.isLoading);
  const isFetching = metricsQueries.some((q) => q.isFetching);
  const lastUpdated = metricsQueries.length > 0 && metricsQueries[0]?.dataUpdatedAt ? new Date(metricsQueries[0].dataUpdatedAt) : null;

  const handleRefresh = () => {
    refetchStatus();
    metricsQueries.forEach((q) => q.refetch());
  };

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onHide();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [show, onHide]);

  return (
    <>
      {show &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[1055] bg-black/40 rb-backdrop-in" onClick={onHide} />
            <div className="fixed inset-x-0 bottom-0 z-[1060] flex flex-col border-t border-hairline bg-card text-ink shadow-card-dark rb-sheet-in" style={{ height: '70vh' }}>
              {/* Header */}
              <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3">
                <BsShieldCheck className="text-primary-500" />
                <span className="font-display font-semibold text-ink">Hedge Replace Windows</span>
                {lastUpdated && <small className="text-ink-faint">Updated: {format(lastUpdated, 'HH:mm:ss')}</small>}
                <div className="ml-auto flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setShowStatusModal(true)} title="View hedge replace status">
                    <BsListUl />
                    <span>Status</span>
                    {hedgeReplaceStats.total > 0 && <Badge tone="info">{hedgeReplaceStats.total}</Badge>}
                  </Button>
                  <Button variant="warning" size="sm" onClick={() => setShowRecoveryModal(true)} title="Trigger hedge replace for missed trades or recover incomplete ones">
                    <BsPlayFill />
                    <span>Trigger/Recover</span>
                    {hedgeReplaceStats.failed > 0 && <Badge tone="danger">{hedgeReplaceStats.failed}</Badge>}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleRefresh} disabled={isFetching}>
                    {isFetching ? <Spinner size="sm" /> : <BsArrowClockwise />}
                    <span>Refresh</span>
                  </Button>
                  <button type="button" onClick={onHide} aria-label="Close" className="rounded p-1 text-ink-faint hover:bg-raised hover:text-ink">
                    <BsX size={20} />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-4">
                {statusError && (
                  <div className="mb-3 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
                    Failed to load exchange status: {(statusError as Error).message}
                  </div>
                )}

                {isLoading ? (
                  <div className="py-4 text-center text-primary-500">
                    <Spinner />
                    <p className="mt-2 text-ink-soft">Loading hedge windows...</p>
                  </div>
                ) : runningExchanges.length === 0 ? (
                  <div className="flex items-center gap-2 rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink">
                    <BsShieldCheck />
                    No strategy engines are currently running. Start an engine to see hedge window schedules.
                  </div>
                ) : (
                  <>
                    {/* Overall Summary Stats */}
                    <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
                      {Tile({ value: runningExchanges.length, label: 'Active Exchanges', tone: 'text-primary-500' })}
                      {Tile({ value: overallStats.totalStrategies, label: 'Registered Strategies', tone: 'text-accent-500' })}
                      {Tile({ value: <>{overallStats.morningCompleted}/{overallStats.totalStrategies}</>, label: 'Morning Complete', tone: 'text-warning-500' })}
                      {Tile({ value: overallStats.eveningScheduled, label: 'Evening Scheduled', tone: 'text-ink-soft' })}
                      {Tile({ value: overallStats.totalExecuted, label: 'Executed Today', tone: 'text-success-500' })}
                    </div>

                    {/* Per-Exchange collapsibles */}
                    {exchangeMetrics.map(({ exchange, metrics, isLoading: isExLoading, error }, index) => (
                      <Collapsible
                        key={exchange}
                        defaultOpen={index === 0}
                        header={
                          <div className="flex w-full items-center gap-2">
                            <Badge tone={metrics?.hedges?.running ? 'success' : 'neutral'}>{exchange}</Badge>
                            <span className="text-sm text-ink-soft">{metrics?.hedges?.summary?.registeredStrategies ?? 0} strategies</span>
                            {metrics?.hedges?.summary?.windowTimes && (
                              <span className="ml-auto text-sm text-ink-soft">
                                Morning: {metrics.hedges.summary.windowTimes.morningStart} | Evening: {metrics.hedges.summary.windowTimes.eveningStart}
                              </span>
                            )}
                          </div>
                        }
                      >
                        {isExLoading ? (
                          <div className="py-3 text-center text-primary-500">
                            <Spinner size="sm" />
                          </div>
                        ) : error ? (
                          <div className="rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-ink">Failed to load: {error.message}</div>
                        ) : (
                          <ExchangeHedgeDetails metrics={metrics} exchange={exchange} />
                        )}
                      </Collapsible>
                    ))}
                  </>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}

      {/* Recovery Modal */}
      <Modal
        open={showRecoveryModal}
        onClose={() => setShowRecoveryModal(false)}
        size="lg"
        title={
          <span className="flex items-center gap-2">
            <BsPlayFill className="text-warning-500" />
            Hedge Replace - Trigger / Recovery
          </span>
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowRecoveryModal(false)}>
              Close
            </Button>
            <Button variant="warning" onClick={() => recoveryMutation.mutate({ strategyName: selectedStrategy, windowType: selectedWindowType })} disabled={recoveryMutation.isPending}>
              {recoveryMutation.isPending ? (
                <>
                  <Spinner size="sm" /> Running...
                </>
              ) : (
                <>
                  <BsPlayFill /> Run Trigger / Recovery
                </>
              )}
            </Button>
          </>
        }
      >
        <div className="mb-3 rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink">
          <strong>This action will:</strong>
          <ul className="mb-0 mt-1 list-disc pl-5">
            <li>
              <strong>Trigger</strong> hedge replace for trades that missed the scheduled window (e.g., due to app restart)
            </li>
            <li>
              <strong>Recover</strong> trades where hedge replace started but didn't complete (e.g., order failures)
            </li>
          </ul>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-soft">
              Strategy <HelpIcon article={helpContent['terminal.hedgeWindows.strategy'] as never} />
            </label>
            <select className={ctrl} value={selectedStrategy} onChange={(e) => setSelectedStrategy(e.target.value)}>
              <option value="ALL">ALL (All strategies)</option>
              {strategyList.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-faint">Select a specific strategy or ALL</p>
          </div>
          <div>
            <label className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-soft">
              Window Type <HelpIcon article={helpContent['terminal.hedgeWindows.windowType'] as never} />
            </label>
            <select className={ctrl} value={selectedWindowType} onChange={(e) => setSelectedWindowType(e.target.value as 'MORNING' | 'EVENING')}>
              <option value="MORNING">MORNING (Positional → Intraday)</option>
              <option value="EVENING">EVENING (Intraday → Positional)</option>
            </select>
          </div>
        </div>

        {/* Recovery Result */}
        {recoveryResult && (
          <div className="mt-3">
            <div className={`mb-2 rounded border px-3 py-2 text-sm ${recoveryResult.success ? 'border-success-500/30 bg-success-500/10' : 'border-warning-500/30 bg-warning-500/10'} text-ink`}>
              <div>{recoveryResult.message}</div>
              <hr className="my-2 border-hairline" />
              <div className="grid grid-cols-4 gap-2 text-center">
                <div>
                  Checked: <strong>{recoveryResult.tradesChecked}</strong>
                </div>
                <div>
                  Triggered/Recovered: <strong className="text-success-500">{recoveryResult.tradesRecovered}</strong>
                </div>
                <div>
                  Failed: <strong className="text-danger-500">{recoveryResult.tradesFailed}</strong>
                </div>
                <div>
                  In Progress: <strong className="text-warning-500">{recoveryResult.tradesInProgress}</strong>
                </div>
              </div>
            </div>
            {recoveryResult.details && recoveryResult.details.length > 0 && (
              <div style={{ maxHeight: '300px', overflowY: 'auto' }} className="overflow-x-auto rounded border border-hairline">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-[1] bg-raised text-ink-faint">
                    <tr>
                      <th className={`${cell} text-left`}>Trade ID</th>
                      <th className={`${cell} text-left`}>User/Broker</th>
                      <th className={`${cell} text-left`}>Strategy</th>
                      <th className={`${cell} text-left`}>Group</th>
                      <th className={`${cell} text-left`}>Status</th>
                      <th className={`${cell} text-left`}>Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {recoveryResult.details.map((d, i) => (
                      <tr key={i}>
                        <td className={cell}>
                          <code className="text-[0.7rem] text-ink" title={d.tradeID}>
                            ...{d.tradeID.slice(-8)}
                          </code>
                        </td>
                        <td className={cell}>
                          <div className="text-ink">{d.username}</div>
                          <div className="text-ink-faint" style={{ fontSize: '0.75rem' }}>
                            {d.broker}
                          </div>
                        </td>
                        <td className={`${cell} text-ink`}>{d.strategy || '-'}</td>
                        <td className={`${cell} text-ink`}>{d.group || '-'}</td>
                        <td className={cell}>
                          <Badge tone={d.status === 'NONE' ? 'neutral' : 'info'}>{d.status}</Badge>
                        </td>
                        <td className={cell}>
                          <Badge
                            tone={
                              d.action === 'TRIGGERED' || d.action === 'RECOVERED'
                                ? 'success'
                                : d.action === 'FAILED' || d.action === 'TRIGGER_FAILED'
                                  ? 'danger'
                                  : d.action === 'IN_PROGRESS'
                                    ? 'warning'
                                    : 'neutral'
                            }
                          >
                            {d.action}
                          </Badge>
                          {d.error && (
                            <div className="text-danger-500" style={{ fontSize: '0.7rem' }}>
                              {d.error}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Status Modal */}
      <Modal
        open={showStatusModal}
        onClose={() => setShowStatusModal(false)}
        size="lg"
        title={
          <span className="flex items-center gap-2">
            <BsListUl className="text-accent-500" />
            Hedge Replace Status
            <Button variant="secondary" size="sm" onClick={() => refetchHedgeStatus()} disabled={isHedgeStatusLoading}>
              <BsArrowClockwise />
            </Button>
          </span>
        }
        footer={
          <Button variant="secondary" onClick={() => setShowStatusModal(false)}>
            Close
          </Button>
        }
      >
        {/* Status Summary */}
        <div className="mb-3 grid grid-cols-3 gap-2 md:grid-cols-6">
          {Tile({ value: hedgeReplaceStats.total, label: 'Total', tone: 'text-primary-500', sm: true })}
          {Tile({ value: hedgeReplaceStats.pending, label: 'Pending', tone: 'text-warning-500', sm: true })}
          {Tile({ value: hedgeReplaceStats.filled, label: 'Filled', tone: 'text-accent-500', sm: true })}
          {Tile({ value: hedgeReplaceStats.exitPending, label: 'Exit Pending', tone: 'text-ink-soft', sm: true })}
          {Tile({ value: hedgeReplaceStats.complete, label: 'Complete', tone: 'text-success-500', sm: true })}
          {Tile({ value: hedgeReplaceStats.failed, label: 'Failed', tone: 'text-danger-500', sm: true })}
        </div>

        {/* Status List */}
        {isHedgeStatusLoading ? (
          <div className="py-3 text-center text-primary-500">
            <Spinner size="sm" />
          </div>
        ) : hedgeReplaceStatus?.data && hedgeReplaceStatus.data.length > 0 ? (
          <div style={{ maxHeight: '400px', overflowY: 'auto' }} className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-[1] bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`}>Trade</th>
                  <th className={`${cell} text-left`}>User/Broker</th>
                  <th className={`${cell} text-left`}>Strategy</th>
                  <th className={`${cell} text-left`}>Status</th>
                  <th className={`${cell} text-left`}>Window</th>
                  <th className={`${cell} text-left`}>Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {hedgeReplaceStatus.data.map((item) => (
                  <HedgeReplaceStatusRow key={item.tradeID} item={item} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink">
            <BsShieldCheck />
            No hedge replace operations in progress or recently completed.
          </div>
        )}
      </Modal>
    </>
  );
};

// Hedge replace status row component
const hedgeStatusTone: Record<string, Tone> = {
  NEW_HEDGE_PENDING: 'warning',
  NEW_HEDGE_FILLED: 'info',
  OLD_HEDGE_EXIT_PENDING: 'neutral',
  COMPLETE: 'success',
  FAILED: 'danger',
};
const hedgeStatusLabel: Record<string, string> = {
  NEW_HEDGE_PENDING: 'Pending',
  NEW_HEDGE_FILLED: 'Filled',
  OLD_HEDGE_EXIT_PENDING: 'Exit Pending',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
};

const HedgeReplaceStatusRow: React.FC<{ item: HedgeReplaceStatusItem }> = ({ item }) => (
  <tr>
    <td className={`${cell} text-xs`}>
      <code className="text-ink">{item.tradeID}</code>
      {item.newHedgeTradeID && (
        <div className="text-ink-faint" style={{ fontSize: '0.75rem' }}>
          New: {item.newHedgeTradeID}
        </div>
      )}
    </td>
    <td className={`${cell} text-xs`}>
      <span className="text-ink">{item.username}</span>
      <div className="text-ink-faint">{item.broker}</div>
    </td>
    <td className={`${cell} text-xs text-ink`}>{item.strategy}</td>
    <td className={cell}>
      <Badge tone={hedgeStatusTone[item.hedgeReplaceStatus] || 'neutral'}>{hedgeStatusLabel[item.hedgeReplaceStatus] || item.hedgeReplaceStatus}</Badge>
    </td>
    <td className={cell}>
      <Badge tone={item.hedgeReplaceWindowType === 'MORNING' ? 'warning' : 'info'}>{item.hedgeReplaceWindowType || '-'}</Badge>
    </td>
    <td className={`${cell} text-xs text-danger-500`}>{item.hedgeReplaceFailureReason || '-'}</td>
  </tr>
);

// Exchange-specific hedge details component
const ExchangeHedgeDetails: React.FC<{ metrics: ExchangeEngineMetrics | null; exchange: string }> = ({ metrics, exchange }) => {
  const hedgeData = metrics?.hedges;
  const summary = hedgeData?.summary;
  const strategies = hedgeData?.strategies || [];

  if (!hedgeData) {
    return <div className="py-3 text-center text-ink-soft">No hedge data available for {exchange}</div>;
  }

  return (
    <>
      {/* Window Times Info */}
      {summary?.windowTimes && (
        <div className="mb-3 rounded-card bg-raised p-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex items-center gap-3">
              <BsSunrise className="text-warning-500" size={20} />
              <div>
                <div className="text-sm font-semibold text-ink">Morning Window</div>
                <div className="text-sm text-ink-soft">
                  {summary.windowTimes.morningStart} - {summary.windowTimes.morningEnd}
                </div>
                <div className="text-sm text-ink-soft">Positional (1%) → Intraday (4%)</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <BsSunset className="text-accent-500" size={20} />
              <div>
                <div className="text-sm font-semibold text-ink">Evening Window</div>
                <div className="text-sm text-ink-soft">
                  {summary.windowTimes.eveningStart} - {summary.windowTimes.eveningEnd}
                </div>
                <div className="flex items-center gap-1 text-sm text-ink-soft">
                  Intraday (4%) → Positional (1%)
                  <Badge tone="neutral">Non-expiry</Badge>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Strategy Details Table */}
      {strategies.length > 0 ? (
        <div className="overflow-x-auto" style={{ maxHeight: '250px' }}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-[1] bg-raised text-xs uppercase text-ink-faint">
              <tr>
                <th className={`${cell} text-left`}>Strategy</th>
                <th className={`${cell} text-center`}>Intraday %</th>
                <th className={`${cell} text-center`}>Positional %</th>
                <th className={`${cell} text-center`}>
                  <BsSunrise className="mr-1 inline text-warning-500" size={12} />
                  Morning
                </th>
                <th className={`${cell} text-center`}>
                  <BsSunset className="mr-1 inline text-accent-500" size={12} />
                  Evening
                </th>
                <th className={`${cell} text-center`}>Pending</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {strategies.map((strategy) => (
                <StrategyRow key={strategy.strategyName} strategy={strategy} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="py-3 text-center text-ink-soft">
          <BsShieldCheck size={32} className="mx-auto mb-2 opacity-50" />
          <p className="mb-0 text-sm">No POSITIONAL strategies registered for {exchange}</p>
        </div>
      )}
    </>
  );
};

// Strategy row component
const StrategyRow: React.FC<{ strategy: HedgeWindowStrategy }> = ({ strategy }) => (
  <tr className="hover:bg-raised/50">
    <td className={`${cell} font-medium text-ink`}>{strategy.strategyName}</td>
    <td className={`${cell} text-center`}>{strategy.intradayDistancePercent !== undefined ? <Badge tone="warning">{strategy.intradayDistancePercent}%</Badge> : '-'}</td>
    <td className={`${cell} text-center`}>{strategy.positionalDistancePercent !== undefined ? <Badge tone="info">{strategy.positionalDistancePercent}%</Badge> : '-'}</td>
    <td className={`${cell} text-center`}>{strategy.morningWindow ? <WindowStatus window={strategy.morningWindow} /> : '-'}</td>
    <td className={`${cell} text-center`}>{strategy.eveningWindow ? <WindowStatus window={strategy.eveningWindow} /> : '-'}</td>
    <td className={`${cell} text-center`}>
      <Badge tone={strategy.pendingTasks > 0 ? 'primary' : 'neutral'}>{strategy.pendingTasks}</Badge>
    </td>
  </tr>
);

// Window status badge component
const WindowStatus: React.FC<{ window: HedgeWindow }> = ({ window }) => {
  const icon =
    window.status === 'COMPLETED' ? (
      <BsCheckCircleFill className="text-success-500" size={12} />
    ) : window.status === 'ACTIVE' ? (
      <BsHourglassSplit className="text-warning-500" size={12} />
    ) : window.status === 'SCHEDULED' ? (
      <BsClock className="text-ink-faint" size={12} />
    ) : (
      <BsCircle className="text-ink-faint" size={12} />
    );
  const tone: Tone = window.status === 'COMPLETED' ? 'success' : window.status === 'ACTIVE' ? 'warning' : 'neutral';

  const total = window.replaceTotal ?? 0;
  const done = window.replaceDone ?? 0;
  const failed = window.replaceFailed ?? 0;
  const pending = window.replacePending ?? 0;
  const hasCounts = window.replaceTotal !== undefined && total > 0;

  return (
    <div className="flex flex-col items-center justify-center gap-1">
      <div className="flex items-center gap-1">
        {icon}
        <Badge tone={tone}>{window.windowStart}</Badge>
      </div>
      {hasCounts && (
        <div style={{ fontSize: '0.7rem' }}>
          <span className="text-success-500">done {done}</span>
          {' · '}
          <span className={failed > 0 ? 'font-semibold text-danger-500' : 'text-ink-faint'}>failed {failed}</span>
          {' · '}
          <span className={pending > 0 ? 'font-semibold text-warning-500' : 'text-ink-faint'}>pending {pending}</span>
          {' · '}
          <span className="text-ink-faint">total {total}</span>
        </div>
      )}
    </div>
  );
};

export default HedgeWindowsPanel;
