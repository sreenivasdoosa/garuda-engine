/**
 * TradeSignalDetailsDrawer Component
 * Side panel drawer showing full trade signal details. Tailwind design system.
 */

import React from 'react';
import { BsArrowUp, BsArrowDown } from 'react-icons/bs';
import type { TradeSignal } from '@/types/terminal';
import { Badge, Drawer } from '@/components/ui';

interface TradeSignalDetailsDrawerProps {
  show: boolean;
  onHide: () => void;
  signal: TradeSignal | null;
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="mb-3 overflow-hidden rounded-card border border-hairline">
    <div className="border-b border-hairline px-3 py-2 text-sm font-semibold text-ink">{title}</div>
    {children}
  </div>
);
const KVTable: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <table className="w-full text-sm">
    <tbody>{children}</tbody>
  </table>
);
const KV: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <tr>
    <td className="px-3 py-1.5 align-top text-ink-soft" style={{ width: '40%' }}>
      {label}
    </td>
    <td className="px-3 py-1.5 text-ink">{children}</td>
  </tr>
);
const YesNo: React.FC<{ value: boolean | undefined; yesTone?: 'success' | 'warning' | 'danger' }> = ({ value, yesTone = 'success' }) =>
  value ? <Badge tone={yesTone}>Yes</Badge> : <Badge tone="neutral">No</Badge>;

const TradeSignalDetailsDrawer: React.FC<TradeSignalDetailsDrawerProps> = ({ show, onHide, signal }) => {
  if (!signal) return null;

  const formatTime = (timestamp: number | null | undefined): string => {
    if (!timestamp) return '-';
    const d = new Date(timestamp);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  };
  const formatDateTime = (timestamp: number | null | undefined): string => {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };

  const statusBadge = signal.disabled ? <Badge tone="neutral">Disabled</Badge> : signal.isTriggered ? <Badge tone="success">Triggered</Badge> : <Badge tone="warning">Pending</Badge>;

  const signalTypeBadge = (
    <Badge tone={signal.tradeSignalType?.includes('ENTRY') ? 'info' : 'warning'}>{signal.tradeSignalType?.replace('_', ' ')}</Badge>
  );

  return (
    <Drawer
      open={show}
      onClose={onHide}
      title={
        <span className="flex items-center gap-2">
          <span className="font-bold">{signal.tradingSymbol}</span>
          {signal.direction === 'LONG' ? (
            <Badge tone="success">
              <BsArrowUp /> LONG
            </Badge>
          ) : (
            <Badge tone="danger">
              <BsArrowDown /> SHORT
            </Badge>
          )}
          {statusBadge}
        </span>
      }
    >
      {/* Signal Summary */}
      <Section title="Signal Summary">
        <KVTable>
          <KV label="Signal ID">
            <span className="break-all text-[0.85em] font-medium">{signal.tradeSignalID}</span>
          </KV>
          <KV label="Signal Type">{signalTypeBadge}</KV>
          <KV label="Strategy">
            <Badge tone="neutral">{signal.strategy}</Badge>
          </KV>
          <KV label="Paper Trading">
            <Badge tone={signal.isPaperTrading ? 'info' : 'neutral'}>{signal.isPaperTrading ? 'true' : 'false'}</Badge>
          </KV>
          <KV label="Mock">
            <Badge tone={signal.isMock ? 'warning' : 'neutral'}>{signal.isMock ? 'true' : 'false'}</Badge>
          </KV>
          <KV label="Group">{signal.group || '-'}</KV>
          <KV label="Tranch">{signal.tranch || '-'}</KV>
          <KV label="Product">{signal.product}</KV>
          <KV label="Product Type">{signal.productType || '-'}</KV>
          <KV label="Exchange / Segment">
            {signal.exchange} / {signal.segment || '-'}
          </KV>
        </KVTable>
      </Section>

      {/* Instrument Details */}
      <Section title="Instrument Details">
        <KVTable>
          <KV label="Trading Symbol">
            <span className="font-medium">{signal.tradingSymbol}</span>
          </KV>
          {signal.isOptions && (
            <KV label="Option Type">
              <Badge tone={signal.optionType === 'CE' ? 'success' : 'danger'}>{signal.optionType}</Badge>
            </KV>
          )}
          {signal.isFutures && (
            <KV label="Instrument Type">
              <Badge tone="info">Futures</Badge>
            </KV>
          )}
          {signal.baseStrike && signal.baseStrike > 0 && <KV label="Base Strike">{signal.baseStrike}</KV>}
        </KVTable>
      </Section>

      {/* Order Parameters */}
      <Section title="Order Parameters">
        <KVTable>
          <KV label="Quantity">
            {signal.quantity} ({signal.quantity / (signal.quantityPerLot || 1)} lots)
          </KV>
          <KV label="Lot Size">{signal.quantityPerLot || 1}</KV>
          <KV label="Trigger Price">{signal.trigger?.toFixed(2) || '-'}</KV>
          <KV label="Stop Loss">{signal.stopLoss?.toFixed(2) || '-'}</KV>
          <KV label="Target">{signal.target?.toFixed(2) || '-'}</KV>
          <KV label="Market Order">
            <YesNo value={signal.placeMarketOrder} />
          </KV>
          <KV label="No Stop Loss">
            <YesNo value={signal.noStopLoss} yesTone="warning" />
          </KV>
          <KV label="No Target">
            <YesNo value={signal.noTarget} yesTone="warning" />
          </KV>
        </KVTable>
      </Section>

      {/* Timing */}
      <Section title="Timing">
        <KVTable>
          <KV label="Signal Generated">{formatDateTime(signal.signalGenerationTime)}</KV>
          <KV label="Timestamp">{formatDateTime(signal.timestamp)}</KV>
          {signal.tradeCutOffTime && <KV label="Trade Cut Off">{formatTime(signal.tradeCutOffTime)}</KV>}
          {signal.cancelUnfilledOrderAt && <KV label="Cancel Unfilled At">{formatTime(signal.cancelUnfilledOrderAt)}</KV>}
          {signal.validTill && <KV label="Valid Till">{formatTime(signal.validTill)}</KV>}
        </KVTable>
      </Section>

      {/* Status & Execution */}
      <Section title="Status & Execution">
        <KVTable>
          <KV label="Status">{statusBadge}</KV>
          <KV label="Triggered">
            <YesNo value={signal.isTriggered} />
          </KV>
          <KV label="Disabled">
            <YesNo value={signal.disabled} yesTone="danger" />
          </KV>
          {signal.disabledReason && (
            <KV label="Disabled Reason">
              <span className="text-danger-500">{signal.disabledReason}</span>
            </KV>
          )}
          <KV label="Current Trade Count">
            {signal.currentTradeCount || 0} / {signal.maxTradesPerStock || 1}
          </KV>
          {signal.reEntryCount !== undefined && signal.reEntryCount > 0 && <KV label="Re-Entry Count">{signal.reEntryCount}</KV>}
          {signal.slice !== undefined && signal.slice > 0 && <KV label="Partial Trade #">{signal.slice}</KV>}
        </KVTable>
      </Section>

      {/* Correlation IDs */}
      {(signal.hedgeCorrelationID || signal.hedgeDistancePercentage || signal.pairTradeCorrelationID) && (
        <Section title="Correlation">
          <KVTable>
            {signal.hedgeCorrelationID && (
              <KV label="Hedge Correlation">
                <span className="break-all text-[0.85em]">{signal.hedgeCorrelationID}</span>
              </KV>
            )}
            {signal.hedgeDistancePercentage !== undefined && signal.hedgeDistancePercentage > 0 && (
              <KV label="Hedge Distance">
                <Badge tone="info">{signal.hedgeDistancePercentage}%</Badge>
              </KV>
            )}
            {signal.pairTradeCorrelationID && (
              <KV label="Pair Trade">
                <span className="break-all text-[0.85em]">{signal.pairTradeCorrelationID}</span>
              </KV>
            )}
          </KVTable>
        </Section>
      )}

      {/* Remarks */}
      {signal.remarks && (
        <Section title="Remarks">
          <p className="mb-0 px-3 py-2 text-ink">{signal.remarks}</p>
        </Section>
      )}

      {/* User & Broker Info */}
      <Section title="User & Broker">
        <KVTable>
          <KV label="Username">{signal.username}</KV>
          <KV label="Broker">{signal.broker}</KV>
          {signal.clientID && <KV label="Client ID">{signal.clientID}</KV>}
        </KVTable>
      </Section>
    </Drawer>
  );
};

export default TradeSignalDetailsDrawer;
