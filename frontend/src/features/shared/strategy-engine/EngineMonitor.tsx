/**
 * EngineMonitor Component
 * Displays strategy engine status for all exchanges with per-exchange controls
 */

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BsPlay, BsStop, BsArrowClockwise, BsActivity, BsCpu, BsClock, BsShieldCheck, BsPower, BsChevronDown, BsChevronRight } from 'react-icons/bs';
import { toast } from 'react-toastify';

import { engineControlService } from '@/services/admin/strategyEngineService';
import type { ExchangeEngineStatus } from '@/types/strategy-engine';
import { ConfirmModal } from '@/components/common';
import { Badge, Button, Spinner } from '@/components/ui';

interface EngineMonitorProps {
  compact?: boolean;
  showExchange?: string;
}

interface ExchangeRowProps {
  status: ExchangeEngineStatus;
  onStart: (exchange: string) => void;
  onStop: (exchange: string) => void;
  onReload: (exchange: string) => void;
  onToggleDryRun: (exchange: string, enable: boolean) => void;
  isStarting: boolean;
  isStopping: boolean;
  isReloading: boolean;
  isTogglingDryRun: boolean;
}

const card = 'rounded-card border border-hairline bg-card';
const cell = 'px-3 py-2';
const dangerBox = 'rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400';

const ExchangeRow: React.FC<ExchangeRowProps> = ({ status, onStart, onStop, onReload, onToggleDryRun, isStarting, isStopping, isReloading, isTogglingDryRun }) => {
  const isMutating = isStarting || isStopping || isReloading || isTogglingDryRun;
  return (
    <tr className="hover:bg-raised/50">
      <td className={`${cell} font-semibold text-ink`}>{status.exchange}</td>
      <td className={`${cell} text-center`}>
        <Badge tone={status.running ? 'success' : 'neutral'}>{status.running ? 'Running' : 'Stopped'}</Badge>
        {status.dryRunMode && <Badge tone="warning" className="ml-1">Dry Run</Badge>}
      </td>
      <td className={`${cell} text-center text-ink`}>{status.activeSubscriptions}</td>
      <td className={`${cell} text-center text-ink`}>{status.scheduledTranches}</td>
      <td className={`${cell} text-center text-ink`}>{status.executedTranches}</td>
      <td className={`${cell} text-center text-ink`}>{status.scheduledHedges || 0}</td>
      <td className={`${cell} text-right`}>
                  <div className="flex justify-end gap-1">
            {status.running ? (
              <Button variant="danger" size="sm" onClick={() => onStop(status.exchange)} disabled={isMutating} title="Stop Engine">
                {isStopping ? <Spinner size="sm" /> : <BsStop />}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => onStart(status.exchange)} disabled={isMutating} title="Start Engine">
                {isStarting ? <Spinner size="sm" /> : <BsPlay />}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => onReload(status.exchange)} disabled={isMutating} title="Reload Subscriptions">
              {isReloading ? <Spinner size="sm" /> : <BsArrowClockwise />}
            </Button>
            <Button variant={status.dryRunMode ? 'warning' : 'secondary'} size="sm" onClick={() => onToggleDryRun(status.exchange, !status.dryRunMode)} disabled={isMutating} title={status.dryRunMode ? 'Disable Dry Run' : 'Enable Dry Run'}>
              {isTogglingDryRun ? <Spinner size="sm" /> : <BsShieldCheck />}
            </Button>
          </div>
        
      </td>
    </tr>
  );
};

const EngineMonitor: React.FC<EngineMonitorProps> = ({ compact = false, showExchange }) => {
  const queryClient = useQueryClient();

  const [mutatingExchange, setMutatingExchange] = React.useState<string | null>(null);
  const [mutationType, setMutationType] = React.useState<'start' | 'stop' | 'reload' | 'dryrun' | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);

  const { data: allStatus, isLoading: statusLoading, error: statusError } = useQuery({
    queryKey: ['engine-status-all'],
    queryFn: () => engineControlService.getAllStatus(),
    refetchInterval: 5000,
  });

  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['engine-metrics', showExchange],
    queryFn: () => (showExchange ? engineControlService.getMetrics(showExchange) : null),
    refetchInterval: 5000,
    enabled: !compact && !!showExchange,
  });

  const startMutation = useMutation({
    mutationFn: (exchange: string) => {
      setMutatingExchange(exchange);
      setMutationType('start');
      return engineControlService.start(exchange);
    },
    onSuccess: (_, exchange) => {
      queryClient.invalidateQueries({ queryKey: ['engine-status-all'] });
      toast.success(`Engine started for ${exchange}`);
    },
    onError: (error: Error, exchange) => toast.error(`Failed to start engine for ${exchange}: ${error.message}`),
    onSettled: () => {
      setMutatingExchange(null);
      setMutationType(null);
    },
  });

  const stopMutation = useMutation({
    mutationFn: (exchange: string) => {
      setMutatingExchange(exchange);
      setMutationType('stop');
      return engineControlService.stop(exchange);
    },
    onSuccess: (_, exchange) => {
      queryClient.invalidateQueries({ queryKey: ['engine-status-all'] });
      toast.success(`Engine stopped for ${exchange}`);
    },
    onError: (error: Error, exchange) => toast.error(`Failed to stop engine for ${exchange}: ${error.message}`),
    onSettled: () => {
      setMutatingExchange(null);
      setMutationType(null);
    },
  });

  const reloadMutation = useMutation({
    mutationFn: (exchange: string) => {
      setMutatingExchange(exchange);
      setMutationType('reload');
      return engineControlService.reload(exchange);
    },
    onSuccess: (_, exchange) => {
      queryClient.invalidateQueries({ queryKey: ['engine-status-all'] });
      toast.success(`Subscriptions reloaded for ${exchange}`);
    },
    onError: (error: Error, exchange) => toast.error(`Failed to reload subscriptions for ${exchange}: ${error.message}`),
    onSettled: () => {
      setMutatingExchange(null);
      setMutationType(null);
    },
  });

  const dryRunMutation = useMutation({
    mutationFn: ({ exchange, enable }: { exchange: string; enable: boolean }) => {
      setMutatingExchange(exchange);
      setMutationType('dryrun');
      return enable ? engineControlService.enableDryRun(exchange) : engineControlService.disableDryRun(exchange);
    },
    onSuccess: (data, { exchange }) => {
      queryClient.invalidateQueries({ queryKey: ['engine-status-all'] });
      toast.success(`Dry run ${data.dryRunMode ? 'enabled' : 'disabled'} for ${exchange}`);
    },
    onError: (error: Error, { exchange }) => toast.error(`Failed to toggle dry run for ${exchange}: ${error.message}`),
    onSettled: () => {
      setMutatingExchange(null);
      setMutationType(null);
    },
  });

  const shutdownAllMutation = useMutation({
    mutationFn: () => engineControlService.shutdownAll(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['engine-status-all'] });
      toast.success('All engines shut down');
    },
    onError: (error: Error) => toast.error(`Failed to shutdown all engines: ${error.message}`),
  });

  if (statusError) {
    return <div className={dangerBox}>Failed to load engine status: {(statusError as Error).message}</div>;
  }

  if (statusLoading || !allStatus) {
    return (
      <div className={card}>
        <div className="py-4 text-center">
          <Spinner className="text-primary-500" />
          <p className="mb-0 mt-2 text-ink-soft">Loading engine status...</p>
        </div>
      </div>
    );
  }

  const exchanges = showExchange ? allStatus.exchanges.filter((e) => e.exchange === showExchange) : allStatus.exchanges;
  const totalSubscriptions = allStatus.exchanges.reduce((sum, e) => sum + e.activeSubscriptions, 0);
  const totalScheduledTranches = allStatus.exchanges.reduce((sum, e) => sum + e.scheduledTranches, 0);
  const totalExecutedTranches = allStatus.exchanges.reduce((sum, e) => sum + e.executedTranches, 0);
  const actualRunningEngines = allStatus.exchanges.filter((e) => e.running).length;

  const shutdownConfirmModal = (
    <ConfirmModal
      show={showShutdownConfirm}
      title="Shutdown all engines?"
      message={'This will stop every exchange engine and tear down the shared thread pools. Active strategies stop signalling immediately. Any scheduled tranches still pending for today will not fire. A fresh start is required to resume operations.\n\nAre you sure?'}
      confirmLabel="Shutdown All"
      confirmVariant="danger"
      onConfirm={() => {
        setShowShutdownConfirm(false);
        shutdownAllMutation.mutate();
      }}
      onCancel={() => setShowShutdownConfirm(false)}
      isLoading={shutdownAllMutation.isPending}
    />
  );

  // Compact mode for Terminal page
  if (compact) {
    return (
      <>
        <div className={`${card} mb-3`}>
          <div className="p-2">
            <div className="flex cursor-pointer items-center justify-between" onClick={() => setIsExpanded(!isExpanded)}>
              <div className="flex flex-wrap items-center gap-2">
                {isExpanded ? <BsChevronDown size={14} className="text-ink-soft" /> : <BsChevronRight size={14} className="text-ink-soft" />}
                <BsCpu className="text-primary-500" size={20} />
                <strong className="text-ink">Strategy Engine</strong>
                <Badge tone={actualRunningEngines > 0 ? 'success' : 'neutral'}>{actualRunningEngines} / {allStatus.exchanges.length} Running</Badge>
                <span className="ml-2 text-xs text-ink-soft">Subs: {totalSubscriptions} | Sched: {totalScheduledTranches} | Exec: {totalExecutedTranches}</span>
                <span className="ml-2 flex items-center gap-1">
                  {allStatus.exchanges.map((e) => (
                    <span key={e.exchange} title={`${e.exchange} engine is ${e.running ? 'running' : 'stopped'}`}>
                      <Badge tone={e.running ? 'success' : 'danger'}>{e.exchange}</Badge>
                    </span>
                  ))}
                </span>
              </div>
              {actualRunningEngines > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowShutdownConfirm(true);
                  }}
                  disabled={shutdownAllMutation.isPending}
                  title="Shutdown all engines and tear down shared thread pools. Engines will need a fresh start to resume."
                >
                  {shutdownAllMutation.isPending ? <Spinner size="sm" /> : <BsPower />}
                  <span className="ml-1 hidden md:inline">Shutdown All</span>
                </Button>
              )}
            </div>
            {isExpanded && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                  <thead className="bg-raised text-xs uppercase text-ink-faint">
                    <tr>
                      <th className={`${cell} text-left`}>Exchange</th>
                      <th className={`${cell} text-center`}>Status</th>
                      <th className={`${cell} text-center`}>Subs</th>
                      <th className={`${cell} text-center`}>Sched</th>
                      <th className={`${cell} text-center`}>Exec</th>
                      <th className={`${cell} text-right`}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exchanges.map((status) => (
                      <tr key={status.exchange} className="hover:bg-raised/50">
                        <td className={`${cell} font-semibold text-ink`}>{status.exchange}</td>
                        <td className={`${cell} text-center`}>
                          <Badge tone={status.running ? 'success' : 'neutral'}>{status.running ? 'On' : 'Off'}</Badge>
                          {status.dryRunMode && <Badge tone="warning" className="ml-1">DR</Badge>}
                        </td>
                        <td className={`${cell} text-center text-ink`}>{status.activeSubscriptions}</td>
                        <td className={`${cell} text-center text-ink`}>{status.scheduledTranches}</td>
                        <td className={`${cell} text-center text-ink`}>{status.executedTranches}</td>
                        <td className={`${cell} text-right`}>
                                                      <div className="flex justify-end gap-1">
                              {status.running ? (
                                <Button variant="danger" size="sm" onClick={(e) => { e.stopPropagation(); stopMutation.mutate(status.exchange); }} disabled={mutatingExchange === status.exchange} title="Stop">
                                  {mutatingExchange === status.exchange && mutationType === 'stop' ? <Spinner size="sm" /> : <BsStop size={14} />}
                                </Button>
                              ) : (
                                <Button variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); startMutation.mutate(status.exchange); }} disabled={mutatingExchange === status.exchange} title="Start">
                                  {mutatingExchange === status.exchange && mutationType === 'start' ? <Spinner size="sm" /> : <BsPlay size={14} />}
                                </Button>
                              )}
                              <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); reloadMutation.mutate(status.exchange); }} disabled={mutatingExchange === status.exchange} title="Reload">
                                {mutatingExchange === status.exchange && mutationType === 'reload' ? <Spinner size="sm" /> : <BsArrowClockwise size={14} />}
                              </Button>
                            </div>
                          
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        {shutdownConfirmModal}
      </>
    );
  }

  // Full mode for Console/Admin page
  const summaryTiles = [
    { icon: <BsCpu size={32} className="text-primary-500" />, value: actualRunningEngines, label: 'Active Engines' },
    { icon: <BsActivity size={32} className="text-success-500" />, value: totalSubscriptions, label: 'Total Subscriptions' },
    { icon: <BsClock size={32} className="text-warning-500" />, value: totalScheduledTranches, label: 'Scheduled Tranches' },
    { icon: <BsActivity size={32} className="text-accent-500" />, value: totalExecutedTranches, label: 'Executed Tranches' },
  ];

  return (
    <>
      <div className={`${card} mb-4`}>
        <div className="flex items-center justify-between border-b border-hairline p-3">
          <div className="flex items-center gap-2">
            <BsCpu size={20} className="text-ink" />
            <h5 className="mb-0 font-semibold text-ink">Strategy Engine</h5>
            <Badge tone={actualRunningEngines > 0 ? 'success' : 'neutral'}>{actualRunningEngines} / {allStatus.exchanges.length} Exchanges Running</Badge>
          </div>
          {actualRunningEngines > 0 && (
            <Button variant="danger" onClick={() => setShowShutdownConfirm(true)} disabled={shutdownAllMutation.isPending} title="Shutdown all engines and tear down shared thread pools. Engines will need a fresh start to resume.">
              {shutdownAllMutation.isPending ? <Spinner size="sm" /> : <BsPower />}
              Shutdown All
            </Button>
          )}
        </div>
        <div className="p-4">
          {/* Summary Stats */}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {summaryTiles.map((t) => (
              <div key={t.label} className="rounded bg-raised p-3 text-center">
                <div className="mb-2 flex justify-center">{t.icon}</div>
                <h3 className="mb-0 text-2xl font-bold text-ink">{t.value}</h3>
                <small className="text-ink-soft">{t.label}</small>
              </div>
            ))}
          </div>

          {/* Per-Exchange Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`}>Exchange</th>
                  <th className={`${cell} text-center`}>Status</th>
                  <th className={`${cell} text-center`}>Subscriptions</th>
                  <th className={`${cell} text-center`}>Scheduled</th>
                  <th className={`${cell} text-center`}>Executed</th>
                  <th className={`${cell} text-center`}>Hedges</th>
                  <th className={`${cell} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {exchanges.map((status) => (
                  <ExchangeRow
                    key={status.exchange}
                    status={status}
                    onStart={(ex) => startMutation.mutate(ex)}
                    onStop={(ex) => stopMutation.mutate(ex)}
                    onReload={(ex) => reloadMutation.mutate(ex)}
                    onToggleDryRun={(ex, enable) => dryRunMutation.mutate({ exchange: ex, enable })}
                    isStarting={mutatingExchange === status.exchange && mutationType === 'start'}
                    isStopping={mutatingExchange === status.exchange && mutationType === 'stop'}
                    isReloading={mutatingExchange === status.exchange && mutationType === 'reload'}
                    isTogglingDryRun={mutatingExchange === status.exchange && mutationType === 'dryrun'}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Detailed Metrics for selected exchange */}
          {metrics && !metricsLoading && showExchange && (
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className={card}>
                <div className="border-b border-hairline px-3 py-2 text-sm font-bold text-ink">Tranch Scheduler - {showExchange}</div>
                <div className="px-3 py-2">
                  <div className="mb-1 flex justify-between"><span className="text-ink-soft">Scheduled:</span><span className="text-ink">{metrics.tranches?.scheduledTasks ?? 0}</span></div>
                  <div className="mb-1 flex justify-between"><span className="text-ink-soft">Executed:</span><span className="text-ink">{metrics.tranches?.executedTasks ?? 0}</span></div>
                  <div className="flex justify-between items-center"><span className="text-ink-soft">Running:</span><Badge tone={metrics.tranches?.running ? 'success' : 'neutral'}>{metrics.tranches?.running ? 'Yes' : 'No'}</Badge></div>
                </div>
              </div>
              <div className={card}>
                <div className="border-b border-hairline px-3 py-2 text-sm font-bold text-ink">Hedge Scheduler - {showExchange}</div>
                <div className="px-3 py-2">
                  <div className="mb-1 flex justify-between"><span className="text-ink-soft">Scheduled:</span><span className="text-ink">{metrics.hedges?.scheduledTasks ?? 0}</span></div>
                  <div className="mb-1 flex justify-between"><span className="text-ink-soft">Executed:</span><span className="text-ink">{metrics.hedges?.executedTasks ?? 0}</span></div>
                  <div className="flex justify-between items-center"><span className="text-ink-soft">Running:</span><Badge tone={metrics.hedges?.running ? 'success' : 'neutral'}>{metrics.hedges?.running ? 'Yes' : 'No'}</Badge></div>
                </div>
              </div>
              <div className={card}>
                <div className="border-b border-hairline px-3 py-2 text-sm font-bold text-ink">Subscriptions - {showExchange}</div>
                <div className="px-3 py-2">
                  <div className="flex justify-between"><span className="text-ink-soft">Active Count:</span><span className="text-ink">{metrics.subscriptions?.activeCount ?? 0}</span></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {shutdownConfirmModal}
    </>
  );
};

export default EngineMonitor;
