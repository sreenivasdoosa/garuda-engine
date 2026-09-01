/**
 * UserStrategyStatesTab Component
 * Shows strategy execution states for a specific user-broker in the UserDetailsPanel.
 * Tailwind design system.
 */

import React, { useState } from 'react';
import { BsChevronDown, BsChevronRight, BsArrowClockwise } from 'react-icons/bs';
import { format } from 'date-fns';

import { useUserStrategyStates } from '@/hooks/useStrategyStates';
import type { StrategyStateSnapshot, TranchStatus } from '@/types/strategy-engine';
import { Badge, Button, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';

interface UserStrategyStatesTabProps {
  username: string;
  broker: string;
}

const scheduleTone: Record<string, Tone> = {
  SIGNALED: 'success',
  WATCHING: 'info',
  PENDING: 'primary',
  NOT_TODAY: 'neutral',
  PAST_TIME: 'warning',
  NO_TIME: 'neutral',
  INVALID_TIME: 'danger',
  HOLIDAY: 'info',
};
const scheduleLabel: Record<string, string> = {
  SIGNALED: 'Signaled',
  WATCHING: 'Watching',
  PENDING: 'Scheduled',
  NOT_TODAY: 'Not Today',
  PAST_TIME: 'Past Time',
  NO_TIME: 'No Time',
  INVALID_TIME: 'Invalid',
  HOLIDAY: 'Holiday',
};

const cell = 'px-2 py-1.5';

const UserStrategyStatesTab: React.FC<UserStrategyStatesTabProps> = ({ username, broker }) => {
  const [expandedStrategies, setExpandedStrategies] = useState<Set<string>>(new Set());
  const [loadingDetails, setLoadingDetails] = useState<Set<string>>(new Set());
  const [strategyDetails, setStrategyDetails] = useState<Map<string, StrategyStateSnapshot>>(new Map());

  const { states, isLoading, error, refresh, getStrategyDetails } = useUserStrategyStates({ username, broker, enabled: !!username && !!broker });

  const handleToggleExpand = async (strategyName: string) => {
    const newExpanded = new Set(expandedStrategies);
    if (newExpanded.has(strategyName)) {
      newExpanded.delete(strategyName);
    } else {
      newExpanded.add(strategyName);
      if (!strategyDetails.has(strategyName)) {
        setLoadingDetails((prev) => new Set(prev).add(strategyName));
        try {
          const details = await getStrategyDetails(strategyName);
          setStrategyDetails((prev) => new Map(prev).set(strategyName, details));
        } catch (err) {
          console.error('Failed to fetch strategy details:', err);
        } finally {
          setLoadingDetails((prev) => {
            const next = new Set(prev);
            next.delete(strategyName);
            return next;
          });
        }
      }
    }
    setExpandedStrategies(newExpanded);
  };

  const formatTime = (isoString?: string): string => {
    if (!isoString) return '-';
    try {
      return format(new Date(isoString), 'HH:mm:ss');
    } catch {
      return '-';
    }
  };

  const getScheduleStatusBadge = (status?: string) => <Badge tone={(status && scheduleTone[status]) || 'neutral'}>{(status && scheduleLabel[status]) || '-'}</Badge>;

  const renderTranchDetails = (tranches: TranchStatus[] | undefined) => {
    if (!tranches || tranches.length === 0) {
      return <p className="mb-0 text-sm text-ink-soft">No tranch data available</p>;
    }
    return (
      <table className="w-full border border-hairline text-xs [&_td]:border [&_td]:border-hairline [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-hairline [&_th]:px-2 [&_th]:py-1">
        <thead className="bg-raised text-ink-faint">
          <tr>
            <th className="text-center">#</th>
            <th className="text-left">Scheduled Time</th>
            <th className="text-left">Day Condition</th>
            <th className="text-center">Lots</th>
            <th className="text-center">Status</th>
            <th className="text-left">Signaled At</th>
          </tr>
        </thead>
        <tbody>
          {tranches.map((tranch) => (
            <tr key={tranch.tranchNumber}>
              <td className="text-center text-ink">{tranch.tranchNumber}</td>
              <td className="text-ink">{tranch.scheduledTime || '-'}</td>
              <td className="text-ink">
                {tranch.dayCondition || 'All Days'}
                {tranch.todayDayCondition && tranch.dayCondition !== tranch.todayDayCondition && <span className="ml-1 text-ink-faint">(Today: {tranch.todayDayCondition})</span>}
              </td>
              <td className="text-center text-ink">{tranch.lotsConfigured ?? '-'}</td>
              <td className="text-center">{getScheduleStatusBadge(tranch.scheduleStatus)}</td>
              <td className="text-ink">{formatTime(tranch.signaledAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4 text-primary-500">
        <Spinner size="sm" />
        <span className="ml-2 text-ink">Loading strategy states...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
        {error}
        <Button variant="danger" size="sm" onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (!states || states.length === 0) {
    return (
      <div className="py-4 text-center text-ink-soft">
        <p className="mb-2">No strategy subscriptions found for this user-broker</p>
        <Button variant="secondary" size="sm" onClick={refresh}>
          <BsArrowClockwise />
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-ink-soft">
          {states.length} subscription{states.length !== 1 ? 's' : ''} found
        </span>
        <Button variant="secondary" size="sm" onClick={refresh}>
          <BsArrowClockwise />
          Refresh
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-raised text-xs uppercase text-ink-faint">
            <tr>
              <th className={cell} style={{ width: '30px' }}></th>
              <th className={`${cell} text-left`}>Strategy</th>
              <th className={`${cell} text-center`}>Active</th>
              <th className={`${cell} text-center`}>Evaluations</th>
              <th className={`${cell} text-center`}>Signals</th>
              <th className={`${cell} text-center`}>Tranches</th>
              <th className={`${cell} text-left`}>Last Evaluation</th>
              <th className={`${cell} text-left`}>Last Signal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {states.map((state) => {
              const isExpanded = expandedStrategies.has(state.strategyName);
              const isLoadingDetail = loadingDetails.has(state.strategyName);
              const details = strategyDetails.get(state.strategyName);

              return (
                <React.Fragment key={`${state.strategyName}-${state.brokerName}`}>
                  <tr onClick={() => handleToggleExpand(state.strategyName)} className={`cursor-pointer hover:bg-raised/50 ${isExpanded ? 'bg-raised/60' : ''}`}>
                    <td className={`${cell} text-center text-ink`}>{isExpanded ? <BsChevronDown size={14} /> : <BsChevronRight size={14} />}</td>
                    <td className={`${cell} font-medium text-ink`}>{state.strategyName}</td>
                    <td className={`${cell} text-center`}>
                      <Badge tone={state.subscriptionActive ? 'success' : 'neutral'}>{state.subscriptionActive ? 'Yes' : 'No'}</Badge>
                    </td>
                    <td className={`${cell} text-center text-ink`}>{state.evaluationCount}</td>
                    <td className={`${cell} text-center`}>
                      <Badge tone={state.signalCount > 0 ? 'primary' : 'neutral'}>{state.signalCount}</Badge>
                    </td>
                    <td className={`${cell} text-center text-ink`}>
                      {state.tranchesSignaled}/{state.tranchCount}
                    </td>
                    <td className={`${cell} whitespace-nowrap text-ink`}>{formatTime(state.lastEvaluationAt)}</td>
                    <td className={`${cell} whitespace-nowrap text-ink`}>{formatTime(state.lastSignalAt)}</td>
                  </tr>

                  {isExpanded && (
                    <tr>
                      <td colSpan={8} className="p-0">
                        <div className="m-2 rounded-card border border-hairline p-3">
                          {isLoadingDetail ? (
                            <div className="flex items-center justify-center py-2 text-primary-500">
                              <Spinner size="sm" />
                              <span className="ml-2 text-sm text-ink">Loading tranch details...</span>
                            </div>
                          ) : (
                            <>
                              <div className="mb-2 flex flex-wrap gap-4 text-sm">
                                <div>
                                  <span className="text-ink-soft">Capital:</span>{' '}
                                  <strong className="text-ink">{details?.capital ? `₹${details.capital.toLocaleString('en-IN')}` : '-'}</strong>
                                </div>
                                <div>
                                  <span className="text-ink-soft">Trading Date:</span> <strong className="text-ink">{details?.tradingDate || state.tradingDate || '-'}</strong>
                                </div>
                                <div>
                                  <span className="text-ink-soft">Activated:</span> <strong className="text-ink">{formatTime(details?.activatedAt || state.activatedAt)}</strong>
                                </div>
                                {(details?.portfolioSLHit || state.portfolioSLHit) && <Badge tone="danger">SL Hit</Badge>}
                                {(details?.portfolioTargetHit || state.portfolioTargetHit) && <Badge tone="success">Target Hit</Badge>}
                              </div>
                              <div className="mt-2">
                                <h6 className="mb-2 text-sm font-bold text-ink">Tranch Status</h6>
                                {renderTranchDetails(details?.tranches || state.tranches)}
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default UserStrategyStatesTab;
