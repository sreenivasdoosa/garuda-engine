/**
 * BreakoutWatchDetailsDrawer Component
 * Side panel drawer showing full breakout watch details. Tailwind design system.
 */

import React from 'react';
import type { BreakoutWatch } from '@/types/strategy-engine';
import { Badge, Drawer } from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';

interface BreakoutWatchDetailsDrawerProps {
  show: boolean;
  onHide: () => void;
  watch: BreakoutWatch | null;
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

const BreakoutWatchDetailsDrawer: React.FC<BreakoutWatchDetailsDrawerProps> = ({ show, onHide, watch }) => {
  if (!watch) return null;

  const formatToLocalTime = (isoString: string | null | undefined): string => {
    if (!isoString) return '-';
    try {
      return new Date(isoString).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch {
      return isoString;
    }
  };

  const statusBadge = watch.isTriggered ? (
    <Badge tone="success">Triggered</Badge>
  ) : watch.isExpired || watch.isValid === false ? (
    <Badge tone="warning">Expired</Badge>
  ) : (
    <Badge tone="info">Active</Badge>
  );

  const directionTone: Tone = watch.direction === 'ABOVE' ? 'success' : watch.direction === 'BELOW' ? 'danger' : watch.direction === 'EITHER' ? 'warning' : 'neutral';
  const directionBadge = <Badge tone={directionTone}>{watch.direction || '-'}</Badge>;

  const watchTypeBadge = <Badge tone={watch.watchType === 'OPTION_SYMBOL' ? 'primary' : 'neutral'}>{watch.watchType === 'OPTION_SYMBOL' ? 'Option Symbol' : 'Underlying'}</Badge>;

  const triggerModeTone: Tone = watch.triggerMode === 'CANDLE_LOW' ? 'warning' : watch.triggerMode ? 'info' : 'neutral';
  const triggerModeLabel = watch.triggerMode === 'PERCENTAGE' ? 'Percentage' : watch.triggerMode === 'ABSOLUTE' ? 'Absolute' : watch.triggerMode === 'CANDLE_LOW' ? 'Candle Low' : watch.triggerMode || '-';
  const triggerModeBadge = <Badge tone={triggerModeTone}>{triggerModeLabel}</Badge>;

  return (
    <Drawer
      open={show}
      onClose={onHide}
      title={
        <span className="flex items-center gap-2">
          <span className="font-bold">{watch.watchSymbol}</span>
          {watch.optionType && <Badge tone={watch.optionType === 'CE' ? 'success' : 'danger'}>{watch.optionType}</Badge>}
          {statusBadge}
        </span>
      }
    >
      {/* Watch Summary */}
      <Section title="Watch Summary">
        <KVTable>
          <KV label="Watch ID">
            <span className="font-medium">{watch.watchId}</span>
          </KV>
          <KV label="Watch Type">{watchTypeBadge}</KV>
          <KV label="Strategy">
            <Badge tone="neutral">{watch.strategyName}</Badge>
          </KV>
          <KV label="Tranch #">{watch.tranchNumber}</KV>
          <KV label="Group ID">
            <span className="break-all text-[0.9em]">{watch.groupId || '-'}</span>
          </KV>
          <KV label="Exchange">{watch.exchange}</KV>
        </KVTable>
      </Section>

      {/* Trigger Configuration */}
      <Section title="Trigger Configuration">
        <KVTable>
          <KV label="Direction">{directionBadge}</KV>
          <KV label="Trigger Mode">{triggerModeBadge}</KV>
          <KV label="Trigger Value">
            {watch.triggerValue}
            {watch.triggerMode === 'PERCENTAGE' && '%'}
          </KV>
          <KV label="Reference Price">
            <span className="font-medium">{watch.referencePrice?.toFixed(2) || '-'}</span>
          </KV>
          <KV label="Trigger Above">
            <span className="font-medium text-success-500">{watch.triggerPriceAbove?.toFixed(2) || '-'}</span>
          </KV>
          <KV label="Trigger Below">
            <span className="font-medium text-danger-500">{watch.triggerPriceBelow?.toFixed(2) || '-'}</span>
          </KV>
        </KVTable>
      </Section>

      {/* Current Market Data */}
      <Section title="Current Market Data">
        <KVTable>
          <KV label="Current LTP">
            <span className="font-medium">{watch.currentLTP?.toFixed(2) || '-'}</span>
          </KV>
          <KV label="% from Reference">
            {watch.pctFromReference !== undefined ? (
              <span className={watch.pctFromReference < 0 ? 'text-danger-500' : 'text-success-500'}>
                {watch.pctFromReference > 0 ? '+' : ''}
                {watch.pctFromReference.toFixed(2)}%
              </span>
            ) : (
              '-'
            )}
          </KV>
          {(watch.direction === 'ABOVE' || watch.direction === 'EITHER') && (
            <KV label="Distance to Trigger">{watch.distanceToTriggerAbove !== undefined ? watch.distanceToTriggerAbove.toFixed(2) : '-'}</KV>
          )}
          {(watch.direction === 'BELOW' || watch.direction === 'EITHER') && (
            <KV label={watch.direction === 'EITHER' ? 'Distance to Below' : 'Distance to Trigger'}>
              {watch.distanceToTriggerBelow !== undefined ? watch.distanceToTriggerBelow.toFixed(2) : '-'}
            </KV>
          )}
        </KVTable>
      </Section>

      {/* Option Details */}
      {watch.watchType === 'OPTION_SYMBOL' && (
        <Section title="Option Details">
          <KVTable>
            <KV label="Trading Symbol">
              <span className="font-medium">{watch.tradingSymbol || '-'}</span>
            </KV>
            <KV label="Option Type">{watch.optionType ? <Badge tone={watch.optionType === 'CE' ? 'success' : 'danger'}>{watch.optionType}</Badge> : '-'}</KV>
            <KV label="Strike">{watch.strike || '-'}</KV>
            <KV label="Trade Direction">{watch.tradeDirection ? <Badge tone={watch.tradeDirection === 'LONG' ? 'success' : 'danger'}>{watch.tradeDirection}</Badge> : '-'}</KV>
            <KV label="Quantity">
              {watch.quantity || '-'}
              {watch.quantityPerLot && watch.quantity && <span className="ml-1 text-ink-faint">({Math.floor(watch.quantity / watch.quantityPerLot)} lots)</span>}
            </KV>
            <KV label="Lot Size">{watch.quantityPerLot || '-'}</KV>
            <KV label="Entry Premium">{watch.entryPremium?.toFixed(2) || '-'}</KV>
          </KVTable>
        </Section>
      )}

      {/* Underlying Details */}
      {watch.watchType === 'UNDERLYING' && (
        <Section title="Underlying Details">
          <KVTable>
            <KV label="FNO Symbol">
              <span className="font-medium">{watch.fnoSymbol || '-'}</span>
            </KV>
            <KV label="Strike Type">{watch.strikeType || '-'}</KV>
            <KV label="Strike Value">{watch.strikeValue || '-'}</KV>
            <KV label="Option Premium">{watch.optionPremium || '-'}</KV>
            <KV label="Option Premium Upper">{watch.optionPremiumUpper || '-'}</KV>
          </KVTable>
        </Section>
      )}

      {/* Status & Timing */}
      <Section title="Status & Timing">
        <KVTable>
          <KV label="Status">{statusBadge}</KV>
          <KV label="Is Valid">{watch.isValid !== undefined ? watch.isValid ? <Badge tone="success">Yes</Badge> : <Badge tone="warning">No</Badge> : '-'}</KV>
          <KV label="Valid Till">{watch.validTill || '-'}</KV>
          <KV label="Created At">{formatToLocalTime(watch.createdAt)}</KV>
          <KV label="Triggered At">{watch.isTriggered ? formatToLocalTime(watch.triggeredAt) : <span className="text-ink-faint">Not Triggered</span>}</KV>
          {watch.isTriggered && (
            <KV label="Triggered Price">
              <span className="font-medium">{watch.triggeredPrice?.toFixed(2) || '-'}</span>
            </KV>
          )}
          {watch.isExpired && <KV label="Expired At">{formatToLocalTime(watch.expiredAt)}</KV>}
        </KVTable>
      </Section>

      {/* User & Broker Info */}
      <Section title="User & Broker">
        <KVTable>
          <KV label="Username">{watch.username}</KV>
          <KV label="Broker">{watch.brokerName}</KV>
        </KVTable>
      </Section>

      {/* Metadata */}
      {watch.metadata && (
        <Section title="Metadata">
          <pre className="mb-0 p-3 text-xs text-ink" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {typeof watch.metadata === 'string' ? watch.metadata : JSON.stringify(watch.metadata, null, 2)}
          </pre>
        </Section>
      )}
    </Drawer>
  );
};

export default BreakoutWatchDetailsDrawer;
