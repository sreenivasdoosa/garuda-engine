/**
 * BreakoutWatchesTab Component
 * Shows breakout watches for a specific user-broker in the UserDetailsPanel.
 * Tailwind design system.
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { BsArrowClockwise, BsBoxArrowUpRight } from 'react-icons/bs';

import { breakoutWatchService } from '@/services/admin/strategyEngineService';
import type { BreakoutWatch } from '@/types/strategy-engine';
import BreakoutWatchDetailsDrawer from './BreakoutWatchDetailsDrawer';
import { Badge, Button, Spinner } from '@/components/ui';

interface BreakoutWatchesTabProps {
  username: string;
  broker: string;
}

const cell = 'px-2 py-1.5';

const BreakoutWatchesTab: React.FC<BreakoutWatchesTabProps> = ({ username, broker }) => {
  const [watches, setWatches] = useState<BreakoutWatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWatch, setSelectedWatch] = useState<BreakoutWatch | null>(null);
  const [showDrawer, setShowDrawer] = useState(false);

  const { activeWatches, triggeredWatches, expiredWatches } = useMemo(() => {
    const active: BreakoutWatch[] = [];
    const triggered: BreakoutWatch[] = [];
    const expired: BreakoutWatch[] = [];
    for (const watch of watches) {
      if (watch.isTriggered) triggered.push(watch);
      else if (watch.isExpired) expired.push(watch);
      else active.push(watch);
    }
    const sortByCreatedAt = (a: BreakoutWatch, b: BreakoutWatch) => (b.createdAt ? new Date(b.createdAt).getTime() : 0) - (a.createdAt ? new Date(a.createdAt).getTime() : 0);
    active.sort(sortByCreatedAt);
    triggered.sort(sortByCreatedAt);
    expired.sort(sortByCreatedAt);
    return { activeWatches: active, triggeredWatches: triggered, expiredWatches: expired };
  }, [watches]);

  const formatToLocalTime = (isoString: string | null | undefined): string => {
    if (!isoString) return '-';
    try {
      return new Date(isoString).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch {
      return isoString;
    }
  };

  const handleWatchClick = (watch: BreakoutWatch) => {
    setSelectedWatch(watch);
    setShowDrawer(true);
  };
  const handleCloseDrawer = () => setShowDrawer(false);

  const loadWatches = useCallback(async () => {
    if (!username || !broker) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await breakoutWatchService.getByUserBroker(username, broker, true);
      setWatches(result);
      setIsLoaded(true);
    } catch (err) {
      console.error('Failed to load breakout watches:', err);
      setError(err instanceof Error ? err.message : 'Failed to load breakout watches');
    } finally {
      setIsLoading(false);
    }
  }, [username, broker]);

  useEffect(() => {
    loadWatches();
  }, [loadWatches]);

  const handleRefresh = async () => {
    await loadWatches();
  };

  const renderWatchRow = (watch: BreakoutWatch) => (
    <tr key={watch.watchId} onClick={() => handleWatchClick(watch)} className="cursor-pointer hover:bg-raised/50">
      <td className={`${cell} text-ink`}>{watch.watchId}</td>
      <td className={cell}>
        <Badge tone="neutral">{watch.strategyName}</Badge>
      </td>
      <td className={`${cell} text-center text-ink`}>{watch.tranchNumber}</td>
      <td className={cell}>
        <span className="flex items-center">
          <span className="truncate text-ink" style={{ maxWidth: '120px' }} title={watch.watchSymbol}>
            {watch.watchSymbol}
          </span>
          {watch.optionType && (
            <Badge tone={watch.optionType === 'CE' ? 'success' : 'danger'} className="ml-1">
              {watch.optionType}
            </Badge>
          )}
        </span>
      </td>
      <td className={`${cell} text-center`}>
        <Badge tone={watch.isPaperTrading ? 'info' : 'neutral'}>{watch.isPaperTrading ? 'P' : 'L'}</Badge>
      </td>
      <td className={cell}>
        <Badge tone={watch.watchType === 'OPTION_SYMBOL' ? 'primary' : 'neutral'}>{watch.watchType === 'OPTION_SYMBOL' ? 'Option' : 'Underlying'}</Badge>
      </td>
      <td className={`${cell} text-right tabular-nums text-ink`}>{watch.quantity || '-'}</td>
      <td className={`${cell} text-right tabular-nums text-ink`}>{watch.referencePrice?.toFixed(2) || '-'}</td>
      <td className={`${cell} text-right tabular-nums text-ink`}>
        {watch.currentLTP?.toFixed(2) || '-'}
        {watch.pctFromReference !== undefined && watch.pctFromReference !== 0 && (
          <span className={`ml-1 text-xs ${watch.pctFromReference < 0 ? 'text-danger-500' : 'text-success-500'}`}>
            ({watch.pctFromReference > 0 ? '+' : ''}
            {watch.pctFromReference.toFixed(1)}%)
          </span>
        )}
      </td>
      <td className={`${cell} text-right tabular-nums text-ink`}>{watch.triggerPriceAbove?.toFixed(2) || '-'}</td>
      <td className={`${cell} text-right tabular-nums text-ink`}>{watch.triggerPriceBelow?.toFixed(2) || '-'}</td>
      <td className={`${cell} text-center`}>
        <Badge tone={watch.direction === 'ABOVE' ? 'success' : watch.direction === 'BELOW' ? 'danger' : 'warning'}>{watch.direction}</Badge>
      </td>
      <td className={`${cell} text-center`}>
        {watch.isTriggered ? <Badge tone="success">Triggered</Badge> : watch.isExpired || watch.isValid === false ? <Badge tone="warning">Expired</Badge> : <Badge tone="info">Active</Badge>}
      </td>
      <td className={`${cell} whitespace-nowrap text-ink`}>{formatToLocalTime(watch.createdAt)}</td>
      <td className={`${cell} whitespace-nowrap text-ink`}>
        {watch.isTriggered ? formatToLocalTime(watch.triggeredAt) : watch.isExpired ? <span className="text-ink-faint">expired @ {formatToLocalTime(watch.expiredAt)}</span> : <span className="text-ink-faint">-</span>}
      </td>
      <td className={`${cell} text-ink`}>{watch.validTill || '-'}</td>
      <td className={cell}>
        <span className="flex items-center gap-1 text-primary-500">
          <BsBoxArrowUpRight size={12} />
          <span className="text-xs">Details</span>
        </span>
      </td>
    </tr>
  );

  const renderTableHeader = () => (
    <thead className="sticky top-0 z-[1] bg-raised text-ink-faint">
      <tr>
        <th className={`${cell} text-left`}>ID</th>
        <th className={`${cell} text-left`}>Strategy</th>
        <th className={`${cell} text-center`}>T#</th>
        <th className={`${cell} text-left`}>Symbol</th>
        <th className={`${cell} text-center`}>P/L</th>
        <th className={`${cell} text-left`}>Type</th>
        <th className={`${cell} text-right`}>Qty</th>
        <th className={`${cell} text-right`}>Ref Price</th>
        <th className={`${cell} text-right`}>LTP</th>
        <th className={`${cell} text-right`}>Trigger Above</th>
        <th className={`${cell} text-right`}>Trigger Below</th>
        <th className={`${cell} text-center`}>Direction</th>
        <th className={`${cell} text-center`}>Status</th>
        <th className={`${cell} text-left`}>Created At</th>
        <th className={`${cell} text-left`}>Triggered At</th>
        <th className={`${cell} text-left`}>Valid Till</th>
        <th className={`${cell} text-left`}>Details</th>
      </tr>
    </thead>
  );

  const refreshBtn = (
    <Button variant="secondary" size="sm" onClick={handleRefresh} disabled={isLoading}>
      <BsArrowClockwise className={isLoading ? 'animate-spin' : ''} />
      Refresh
    </Button>
  );

  if (isLoading && !isLoaded) {
    return (
      <div className="flex items-center justify-center py-4 text-primary-500">
        <Spinner size="sm" />
        <span className="ml-2 text-ink">Loading breakout watches...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
        {error}
        <Button variant="danger" size="sm" onClick={loadWatches}>
          Retry
        </Button>
      </div>
    );
  }

  if (watches.length === 0) {
    return (
      <div>
        <div className="mb-2 flex justify-end">{refreshBtn}</div>
        <p className="py-3 text-center text-ink-soft">No breakout watches for today</p>
      </div>
    );
  }

  const table = (rows: BreakoutWatch[]) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full text-xs">
        {renderTableHeader()}
        <tbody className="divide-y divide-hairline">{rows.map(renderWatchRow)}</tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-ink-soft">
          {activeWatches.length} active, {triggeredWatches.length} triggered, {expiredWatches.length} expired today
        </span>
        {refreshBtn}
      </div>

      {activeWatches.length > 0 && (
        <>
          <h6 className="mb-2 flex items-center text-sm text-ink-soft">
            <Badge tone="info" className="mr-2">Active</Badge>
            {activeWatches.length} watch{activeWatches.length !== 1 ? 'es' : ''}
          </h6>
          {table(activeWatches)}
        </>
      )}

      {triggeredWatches.length > 0 && (
        <>
          <h6 className="mb-2 mt-3 flex items-center text-sm text-ink-soft">
            <Badge tone="success" className="mr-2">Triggered Today</Badge>
            {triggeredWatches.length} watch{triggeredWatches.length !== 1 ? 'es' : ''}
          </h6>
          {table(triggeredWatches)}
        </>
      )}

      {expiredWatches.length > 0 && (
        <>
          <h6 className="mb-2 mt-3 flex items-center text-sm text-ink-soft">
            <Badge tone="warning" className="mr-2">Expired Today</Badge>
            {expiredWatches.length} watch{expiredWatches.length !== 1 ? 'es' : ''}
          </h6>
          {table(expiredWatches)}
        </>
      )}

      <BreakoutWatchDetailsDrawer show={showDrawer} onHide={handleCloseDrawer} watch={selectedWatch} />
    </div>
  );
};

export default BreakoutWatchesTab;
