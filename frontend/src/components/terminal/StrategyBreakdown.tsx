/**
 * StrategyBreakdown Component
 * Displays strategy-wise P&L breakdown. Tailwind design system.
 */

import React, { useState } from 'react';
import { BsXCircle } from 'react-icons/bs';
import clsx from 'clsx';
import type { StrategySummary } from '@/types/terminal';
import PnLDisplay from './PnLDisplay';
import { valueForMode, countForMode, type TradingMode } from '@/utils/tradingMode';
import { Badge, Button, Modal, Spinner } from '@/components/ui';

interface StrategyBreakdownProps {
  strategies: Record<string, StrategySummary>;
  compact?: boolean;
  username?: string;
  broker?: string;
  onSquareOff?: (strategy: string) => Promise<void>;
  tradingMode?: TradingMode;
}

const cell = 'px-2 py-1.5';

const StrategyBreakdown: React.FC<StrategyBreakdownProps> = ({ strategies, compact = false, username, broker, onSquareOff, tradingMode = 'live' }) => {
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState<StrategySummary | null>(null);
  const [isSquaringOff, setIsSquaringOff] = useState(false);

  const strategyList: StrategySummary[] = Object.values(strategies).map((s) =>
    tradingMode === 'mixed'
      ? s
      : {
          ...s,
          activeTradesCount: countForMode(s.activeTradesCount, s.paperActiveTradesCount, tradingMode),
          completedTradesCount: countForMode(s.completedTradesCount, s.paperCompletedTradesCount, tradingMode),
          realizedPnl: valueForMode(s.realizedPnl, s.paperRealizedPnl, tradingMode),
          unrealizedPnl: valueForMode(s.unrealizedPnl, s.paperUnrealizedPnl, tradingMode),
          totalPnl: valueForMode(s.totalPnl, s.paperTotalPnl, tradingMode),
          charges: valueForMode(s.charges, s.paperCharges, tradingMode),
          netPnl: valueForMode(s.netPnl ?? s.totalPnl - (s.charges || 0), s.paperNetPnl, tradingMode),
        },
  );

  const handleSquareOffClick = (strategy: StrategySummary) => {
    setSelectedStrategy(strategy);
    setShowConfirmModal(true);
  };

  const handleConfirmSquareOff = async () => {
    if (!selectedStrategy || !onSquareOff) return;
    setIsSquaringOff(true);
    try {
      await onSquareOff(selectedStrategy.strategy);
      setShowConfirmModal(false);
      setSelectedStrategy(null);
    } catch (error) {
      console.error('Square off failed:', error);
    } finally {
      setIsSquaringOff(false);
    }
  };

  const handleCloseModal = () => {
    if (!isSquaringOff) {
      setShowConfirmModal(false);
      setSelectedStrategy(null);
    }
  };

  if (strategyList.length === 0) {
    return <div className="py-3 text-center text-ink-soft">No strategies found</div>;
  }

  if (compact) {
    return (
      <div className="flex flex-wrap gap-2">
        {strategyList.map((strategy) => (
          <span
            key={strategy.strategy}
            className={clsx('inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold', strategy.totalPnl >= 0 ? 'bg-success-500/15 text-success-500' : 'bg-danger-500/15 text-danger-500')}
          >
            <span>{strategy.displayName || strategy.strategy}</span>
            <span className="tabular-nums">
              {strategy.totalPnl >= 0 ? '+' : ''}
              {Math.round(strategy.totalPnl).toLocaleString('en-IN')}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-raised text-xs uppercase tracking-wide text-ink-faint">
            <tr>
              <th className={`${cell} text-left`}>Strategy</th>
              <th className={`${cell} text-center`}>Active</th>
              <th className={`${cell} text-center`}>Done</th>
              <th className={`${cell} text-right`}>Realized</th>
              <th className={`${cell} text-right`}>Unrealized</th>
              <th className={`${cell} text-right`}>Total</th>
              {onSquareOff && <th className={`${cell} text-center`}>Action</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {strategyList.map((strategy) => (
              <tr key={strategy.strategy} className="hover:bg-raised/50">
                <td className={cell}>
                  <span className="font-medium text-ink">{strategy.displayName || strategy.strategy}</span>
                  {strategy.product && (
                    <Badge tone="neutral" className="ml-2">
                      {strategy.product}
                    </Badge>
                  )}
                </td>
                <td className={`${cell} text-center`}>
                  {strategy.activeTradesCount > 0 ? <Badge tone="primary">{strategy.activeTradesCount}</Badge> : <span className="text-ink-faint">0</span>}
                </td>
                <td className={`${cell} text-center`}>
                  {strategy.completedTradesCount > 0 ? <Badge tone="neutral">{strategy.completedTradesCount}</Badge> : <span className="text-ink-faint">0</span>}
                </td>
                <td className={`${cell} text-right`}><PnLDisplay value={strategy.realizedPnl} size="sm" fullFormat /></td>
                <td className={`${cell} text-right`}><PnLDisplay value={strategy.unrealizedPnl} size="sm" fullFormat /></td>
                <td className={`${cell} text-right`}><PnLDisplay value={strategy.totalPnl} size="sm" fullFormat /></td>
                {onSquareOff && (
                  <td className={`${cell} text-center`}>
                    {strategy.activeTradesCount > 0 ? (
                      <Button variant="danger" size="sm" onClick={() => handleSquareOffClick(strategy)} title="Square Off Strategy">
                        <BsXCircle />
                        Sq Off
                      </Button>
                    ) : (
                      <span className="text-ink-faint">-</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-raised font-bold">
              <td className={cell}>Total</td>
              <td className={`${cell} text-center`}>{strategyList.reduce((sum, s) => sum + s.activeTradesCount, 0)}</td>
              <td className={`${cell} text-center`}>{strategyList.reduce((sum, s) => sum + s.completedTradesCount, 0)}</td>
              <td className={`${cell} text-right`}><PnLDisplay value={strategyList.reduce((sum, s) => sum + s.realizedPnl, 0)} size="sm" fullFormat /></td>
              <td className={`${cell} text-right`}><PnLDisplay value={strategyList.reduce((sum, s) => sum + s.unrealizedPnl, 0)} size="sm" fullFormat /></td>
              <td className={`${cell} text-right`}><PnLDisplay value={strategyList.reduce((sum, s) => sum + s.totalPnl, 0)} fullFormat /></td>
              {onSquareOff && <td></td>}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Square Off Confirmation Modal */}
      <Modal
        open={showConfirmModal}
        onClose={handleCloseModal}
        title={
          <span className="inline-flex items-center gap-2 text-danger-500">
            <BsXCircle />
            Confirm Square Off
          </span>
        }
        footer={
          <>
            <Button variant="secondary" onClick={handleCloseModal} disabled={isSquaringOff}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleConfirmSquareOff} disabled={isSquaringOff}>
              {isSquaringOff ? (
                <>
                  <Spinner size="sm" />
                  Squaring Off...
                </>
              ) : (
                <>
                  <BsXCircle />
                  Confirm Square Off
                </>
              )}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-ink">Are you sure you want to square off all positions for this strategy?</p>
        <table className="w-full border border-hairline text-sm [&_td]:border [&_td]:border-hairline [&_td]:px-2 [&_td]:py-1.5">
          <tbody>
            <tr>
              <td className="text-ink-soft" style={{ width: '40%' }}>Username</td>
              <td className="font-bold text-ink">{username || '-'}</td>
            </tr>
            <tr>
              <td className="text-ink-soft">Broker</td>
              <td className="font-bold text-ink">{broker || '-'}</td>
            </tr>
            <tr>
              <td className="text-ink-soft">Strategy</td>
              <td className="font-bold text-ink">{selectedStrategy?.displayName || selectedStrategy?.strategy || '-'}</td>
            </tr>
            <tr>
              <td className="text-ink-soft">Active Trades</td>
              <td className="font-bold text-ink">{selectedStrategy?.activeTradesCount || 0}</td>
            </tr>
            <tr>
              <td className="text-ink-soft">Unrealized P&L</td>
              <td><PnLDisplay value={selectedStrategy?.unrealizedPnl ?? 0} size="sm" fullFormat /></td>
            </tr>
          </tbody>
        </table>
      </Modal>
    </>
  );
};

export default StrategyBreakdown;
