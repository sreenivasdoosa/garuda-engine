/**
 * StrategyStatesPanel Component
 * Shows aggregated strategy execution states - tranches signaled, signals generated, etc.
 * Tailwind design system (bottom slide-over).
 */

import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { BsArrowClockwise, BsCheckCircleFill, BsCircle, BsSearch, BsX } from 'react-icons/bs';
import clsx from 'clsx';
import { format } from 'date-fns';

import { useStrategyStates } from '@/hooks/useStrategyStates';
import type { StrategySummaryStats, UserSummaryStats } from '@/types/strategy-engine';
import { Badge, Button, Spinner } from '@/components/ui';

interface StrategyStatesPanelProps {
  show: boolean;
  onHide: () => void;
}

const cell = 'px-2 py-1.5';

const StrategyStatesPanel: React.FC<StrategyStatesPanelProps> = ({ show, onHide }) => {
  const [activeTab, setActiveTab] = useState<'strategy' | 'user'>('strategy');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'signaled' | 'pending'>('all');

  const { states, summary, isLoading, isSummaryLoading, error, refresh, lastUpdated, isRefreshing } = useStrategyStates({ autoRefresh: show });

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onHide();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [show, onHide]);

  const filteredByStrategy = useMemo(() => {
    if (!summary?.byStrategy) return [];
    let filtered = [...summary.byStrategy];
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter((s) => s.strategyName.toLowerCase().includes(term));
    }
    if (statusFilter === 'active') filtered = filtered.filter((s) => s.activeCount > 0);
    else if (statusFilter === 'signaled') filtered = filtered.filter((s) => s.totalSignals > 0);
    else if (statusFilter === 'pending') filtered = filtered.filter((s) => s.activeCount > 0 && s.totalSignals === 0);
    return filtered.sort((a, b) => b.totalSignals - a.totalSignals);
  }, [summary?.byStrategy, searchTerm, statusFilter]);

  const filteredByUser = useMemo(() => {
    if (!summary?.byUser) return [];
    let filtered = [...summary.byUser];
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter((u) => u.username.toLowerCase().includes(term) || u.strategies?.some((s) => s.toLowerCase().includes(term)));
    }
    if (statusFilter === 'active') filtered = filtered.filter((u) => u.activeCount > 0);
    else if (statusFilter === 'signaled') filtered = filtered.filter((u) => u.totalSignals > 0);
    else if (statusFilter === 'pending') filtered = filtered.filter((u) => u.activeCount > 0 && u.totalSignals === 0);
    return filtered.sort((a, b) => b.totalSignals - a.totalSignals);
  }, [summary?.byUser, searchTerm, statusFilter]);

  const tranchStats = useMemo(() => {
    let totalConfigured = 0;
    let totalSignaled = 0;
    let totalScheduled = 0;
    states.forEach((state) => {
      totalConfigured += state.tranchCount || 0;
      totalSignaled += state.tranchesSignaled || 0;
      if (state.tranches) totalScheduled += state.tranches.filter((t) => t.isScheduledToday).length;
    });
    return { totalConfigured, totalSignaled, totalScheduled };
  }, [states]);

  if (!show) return null;

  const summaryTile = (value: React.ReactNode, label: string, tone: string) => (
    <div className="rounded-card border border-hairline bg-card py-2 text-center">
      <div className={`text-2xl font-bold ${tone}`}>{value}</div>
      <small className="text-ink-faint">{label}</small>
    </div>
  );

  const tab = (key: 'strategy' | 'user', label: string) => (
    <button
      type="button"
      onClick={() => setActiveTab(key)}
      className={clsx('-mb-px border-b-2 px-4 py-2 text-sm font-medium', activeTab === key ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink')}
    >
      {label}
    </button>
  );

  return createPortal(
    <>
      <div className="fixed inset-0 z-[1055] bg-black/40 rb-backdrop-in" onClick={onHide} />
      <div className="fixed inset-x-0 bottom-0 z-[1060] flex flex-col border-t border-hairline bg-card text-ink shadow-card-dark rb-sheet-in" style={{ height: '70vh' }}>
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <span className="font-display font-semibold text-ink">Strategy Execution Monitor</span>
          {lastUpdated && <small className="text-ink-faint">Last updated: {format(lastUpdated, 'HH:mm:ss')}</small>}
          <Button variant="secondary" size="sm" onClick={refresh} disabled={isRefreshing} className="ml-auto">
            {isRefreshing ? <Spinner size="sm" /> : <BsArrowClockwise />}
            <span>Refresh</span>
          </Button>
          <button type="button" onClick={onHide} aria-label="Close" className="rounded p-1 text-ink-faint hover:bg-raised hover:text-ink">
            <BsX size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {error && <div className="mb-3 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">{error}</div>}

          {/* Summary Cards */}
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            {summaryTile(<>{summary?.activeSubscriptions ?? '-'}/{summary?.totalSubscriptions ?? '-'}</>, 'Active Subscriptions', 'text-primary-500')}
            {summaryTile(summary?.totalEvaluations ?? '-', 'Evaluations Today', 'text-accent-500')}
            {summaryTile(summary?.totalSignalsGenerated ?? '-', 'Signals Generated', 'text-success-500')}
            {summaryTile(<>{tranchStats.totalScheduled}/{tranchStats.totalConfigured}</>, 'Tranches Scheduled', 'text-ink-soft')}
            {summaryTile(<>{tranchStats.totalSignaled}/{tranchStats.totalScheduled || tranchStats.totalConfigured}</>, 'Tranches Signaled', 'text-warning-500')}
          </div>

          {/* Tabs and Filters */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-hairline">
            <div className="flex gap-1">
              {tab('strategy', 'By Strategy')}
              {tab('user', 'By User')}
            </div>
            <div className="mb-2 flex gap-2">
              <div className="relative" style={{ width: '200px' }}>
                <BsSearch className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
                <input
                  placeholder="Search..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="h-8 w-full rounded border border-hairline bg-card pl-8 pr-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                className="h-8 w-[120px] rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60"
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="signaled">Signaled</option>
                <option value="pending">Pending</option>
              </select>
            </div>
          </div>

          {isLoading || isSummaryLoading ? (
            <div className="py-4 text-center text-primary-500">
              <Spinner />
            </div>
          ) : activeTab === 'strategy' ? (
            <StrategyTable data={filteredByStrategy} />
          ) : (
            <UserTable data={filteredByUser} />
          )}
        </div>
      </div>
    </>,
    document.body,
  );
};

const StrategyTable: React.FC<{ data: StrategySummaryStats[] }> = ({ data }) => {
  if (data.length === 0) return <div className="py-4 text-center text-ink-soft">No strategies found</div>;
  return (
    <div className="overflow-x-auto" style={{ maxHeight: '400px' }}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-[1] bg-raised text-xs uppercase text-ink-faint">
          <tr>
            <th className={`${cell} text-left`}>Strategy</th>
            <th className={`${cell} text-center`}>Subscriptions</th>
            <th className={`${cell} text-center`}>Active</th>
            <th className={`${cell} text-center`}>Signals</th>
            <th className={`${cell} text-center`}>Scheduled</th>
            <th className={`${cell} text-center`}>Signaled</th>
            <th className={`${cell} text-center`}>Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {data.map((strategy) => (
            <tr key={strategy.strategyName} className="hover:bg-raised/50">
              <td className={`${cell} font-medium text-ink`}>{strategy.strategyName}</td>
              <td className={`${cell} text-center text-ink`}>{strategy.subscriptionCount}</td>
              <td className={`${cell} text-center`}>
                <Badge tone={strategy.activeCount > 0 ? 'success' : 'neutral'}>{strategy.activeCount}</Badge>
              </td>
              <td className={`${cell} text-center`}>
                <Badge tone={strategy.totalSignals > 0 ? 'primary' : 'neutral'}>{strategy.totalSignals}</Badge>
              </td>
              <td className={`${cell} text-center`}>
                {strategy.tranchesScheduled !== undefined && strategy.tranchesConfigured !== undefined ? (
                  <span className={strategy.tranchesScheduled > 0 ? 'text-primary-500' : 'text-ink-faint'}>
                    {strategy.tranchesScheduled}/{strategy.tranchesConfigured}
                  </span>
                ) : (
                  '-'
                )}
              </td>
              <td className={`${cell} text-center`}>
                {strategy.tranchesSignaled !== undefined ? (
                  <span className={strategy.tranchesSignaled > 0 ? 'font-bold text-success-500' : 'text-ink-faint'}>
                    {strategy.tranchesSignaled}/{strategy.tranchesScheduled || strategy.tranchesConfigured || 0}
                  </span>
                ) : (
                  '-'
                )}
              </td>
              <td className={`${cell} text-center`}>
                {strategy.totalSignals > 0 ? (
                  <BsCheckCircleFill className="inline text-success-500" title="Signals generated" />
                ) : strategy.activeCount > 0 ? (
                  <BsCircle className="inline text-warning-500" title="Pending" />
                ) : (
                  <BsCircle className="inline text-ink-faint" title="Inactive" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const UserTable: React.FC<{ data: UserSummaryStats[] }> = ({ data }) => {
  if (data.length === 0) return <div className="py-4 text-center text-ink-soft">No users found</div>;
  return (
    <div className="overflow-x-auto" style={{ maxHeight: '400px' }}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-[1] bg-raised text-xs uppercase text-ink-faint">
          <tr>
            <th className={`${cell} text-left`}>User</th>
            <th className={`${cell} text-center`}>Subs</th>
            <th className={`${cell} text-center`}>Active</th>
            <th className={`${cell} text-center`}>Evals</th>
            <th className={`${cell} text-center`}>Signals</th>
            <th className={`${cell} text-center`}>Scheduled</th>
            <th className={`${cell} text-center`}>Signaled</th>
            <th className={`${cell} text-left`}>Strategies</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {data.map((user) => (
            <tr key={user.username} className="hover:bg-raised/50">
              <td className={`${cell} font-medium text-ink`}>{user.username}</td>
              <td className={`${cell} text-center text-ink`}>{user.subscriptionCount}</td>
              <td className={`${cell} text-center`}>
                <Badge tone={user.activeCount > 0 ? 'success' : 'neutral'}>{user.activeCount}</Badge>
              </td>
              <td className={`${cell} text-center text-ink-faint`}>{user.totalEvaluations}</td>
              <td className={`${cell} text-center`}>
                <Badge tone={user.totalSignals > 0 ? 'primary' : 'neutral'}>{user.totalSignals}</Badge>
              </td>
              <td className={`${cell} text-center`}>
                {user.tranchesScheduled !== undefined && user.tranchesConfigured !== undefined ? (
                  <span className={user.tranchesScheduled > 0 ? 'text-primary-500' : 'text-ink-faint'}>
                    {user.tranchesScheduled}/{user.tranchesConfigured}
                  </span>
                ) : (
                  '-'
                )}
              </td>
              <td className={`${cell} text-center`}>
                {user.tranchesSignaled !== undefined ? (
                  <span className={user.tranchesSignaled > 0 ? 'font-bold text-success-500' : 'text-ink-faint'}>
                    {user.tranchesSignaled}/{user.tranchesScheduled || user.tranchesConfigured || 0}
                  </span>
                ) : (
                  '-'
                )}
              </td>
              <td className={cell}>
                <div className="flex flex-wrap gap-1">
                  {user.strategies?.slice(0, 3).map((s) => (
                    <Badge key={s} tone="neutral">
                      {s}
                    </Badge>
                  ))}
                  {user.strategies && user.strategies.length > 3 && <Badge tone="neutral">+{user.strategies.length - 3}</Badge>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default StrategyStatesPanel;
