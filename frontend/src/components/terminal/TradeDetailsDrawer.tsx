/**
 * TradeDetailsDrawer Component
 * Side panel drawer showing full trade details including orders. Tailwind design system.
 */

import React from 'react';
import { BsArrowUp, BsArrowDown } from 'react-icons/bs';
import PnLDisplay from './PnLDisplay';
import { Badge, Drawer } from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';

interface OrderStatusHistoryEntry {
  orderStatus: string;
  lastUpdatedTimestamp: number;
}

interface Order {
  orderId: string;
  username: string;
  broker: string;
  clientID: string;
  exchange: string;
  segment: string;
  productType: string;
  tradingSymbol: string;
  orderStatus: string;
  orderPrevStatus?: string;
  orderStatusHistory?: OrderStatusHistoryEntry[];
  orderType: string;
  prevOrderType?: string;
  tradeID: string;
  price: number;
  triggerPrice: number;
  averagePrice: number;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  filledQuantity: number;
  pendingQuantity: number;
  disclosedQuantity: number;
  orderPlacedTimestamp: number;
  orderExecutedTimestamp?: number;
  parentOrderId?: string;
  message?: string;
  lastOrderUpdateTimestamp: number;
  exchangeOrderId: string;
  numModifyRequests: number;
  exchangeLastUpdateTimestamp?: number;
}

interface ServerTrade {
  tradeID: string;
  strategy: string;
  productType: string;
  group?: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  contractMultiplier?: number;
  filledQuantity: number;
  entry: number;
  exit: number;
  cmp: number;
  stopLoss: number;
  initialStopLoss: number;
  noStopLoss: boolean;
  target: number;
  requestedEntry: number;
  requestedExit: number;
  profitLoss: number;
  charges: number;
  netProfitLoss: number;
  plPercentage: number;
  exitReason?: string;
  failureReason?: string;
  remarks?: string;
  startTimestamp: number;
  endTimestamp?: number;
  state: 'OPEN' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  orderFilled: boolean;
  isMarketOrder: boolean;
  isPaperTrading?: boolean;
  isMock?: boolean;
  order?: Order;
  slOrder?: Order;
  targetOrder?: Order;
  hedgeCorrelationID?: string;
  hedgeTradeID?: string;
  hedgeDistancePercentage?: number;
  pairTradeCorrelationID?: string;
  exitTradeAt?: number;
  // Corporate-action adjustment state (split/bonus). caFactor 1 / absent = never adjusted.
  caFactor?: number;
  originalEntry?: number;
  originalQuantity?: number;
  originalFilledQuantity?: number;
}

interface TradeDetailsDrawerProps {
  show: boolean;
  onHide: () => void;
  trade: ServerTrade | null;
}

// Fixed app-wide trade-state scheme (brand-independent): active=blue,
// completed=green, open=grey, cancelled=amber. Flavor tones (primary/info)
// collide on some brands (pro primary=amber=warning, lab primary=green).
const STATE_TONE: Record<ServerTrade['state'], Tone> = {
  OPEN: 'neutral',
  ACTIVE: 'blue',
  COMPLETED: 'success',
  CANCELLED: 'warning',
};

const statusTone = (status: string | undefined): Tone => {
  const s = status?.toLowerCase() || '';
  if (s.includes('complete')) return 'success';
  if (s.includes('reject') || s.includes('cancel')) return 'danger';
  if (s.includes('pending') || s.includes('trigger')) return 'warning';
  if (s.includes('open')) return 'info';
  return 'neutral';
};
const statusTextClass = (status: string | undefined): string => {
  const s = status?.toLowerCase() || '';
  if (s.includes('complete')) return 'text-success-500';
  if (s.includes('reject') || s.includes('cancel')) return 'text-danger-500';
  if (s.includes('pending') || s.includes('trigger')) return 'text-warning-500';
  if (s.includes('open')) return 'text-primary-500';
  return 'text-ink-soft';
};

const Section: React.FC<{ title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
  <div className="mb-3 overflow-hidden rounded-card border border-hairline">
    <div className="flex items-center justify-between border-b border-hairline px-3 py-2 text-sm font-semibold text-ink">
      <span>{title}</span>
      {right}
    </div>
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

const TradeDetailsDrawer: React.FC<TradeDetailsDrawerProps> = ({ show, onHide, trade }) => {
  if (!trade) return null;

  const formatTime = (timestamp: number | null | undefined): string => {
    if (!timestamp) return '-';
    const d = new Date(timestamp);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  };
  const formatDateTime = (timestamp: number | null | undefined): string => {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };

  const renderOrderCard = (order: Order | undefined, title: string) => {
    if (!order) {
      return (
        <Section title={title}>
          <div className="py-3 text-center text-ink-soft">No {title.toLowerCase()}</div>
        </Section>
      );
    }
    return (
      <Section title={title} right={<Badge tone={statusTone(order.orderStatus)}>{order.orderStatus || '-'}</Badge>}>
        <KVTable>
          <KV label="Order ID">
            <span className="font-medium">{order.orderId}</span>
          </KV>
          <KV label="Exchange Order ID">
            <span className="font-medium">{order.exchangeOrderId || '-'}</span>
          </KV>
          <KV label="Order Type">
            <Badge tone="neutral">{order.orderType}</Badge>
            {order.prevOrderType && order.prevOrderType !== order.orderType && <small className="ml-1 text-ink-faint">(was: {order.prevOrderType})</small>}
          </KV>
          <KV label="Direction">
            {order.direction === 'LONG' ? (
              <Badge tone="success">
                <BsArrowUp /> LONG
              </Badge>
            ) : (
              <Badge tone="danger">
                <BsArrowDown /> SHORT
              </Badge>
            )}
          </KV>
          <KV label="Price">{order.price?.toFixed(2)}</KV>
          {order.triggerPrice > 0 && <KV label="Trigger Price">{order.triggerPrice?.toFixed(2)}</KV>}
          <KV label="Avg Price">{order.averagePrice?.toFixed(2)}</KV>
          <KV label="Quantity">
            {order.filledQuantity}/{order.quantity}
          </KV>
          {order.pendingQuantity > 0 && <KV label="Pending Qty">{order.pendingQuantity}</KV>}
          <KV label="Order Placed">{formatTime(order.orderPlacedTimestamp)}</KV>
          <KV label="Last Update">{formatTime(order.lastOrderUpdateTimestamp)}</KV>
          {order.numModifyRequests > 0 && <KV label="Modify Requests">{order.numModifyRequests}</KV>}
          {order.message && (
            <KV label="Message">
              <span className="break-all font-medium text-danger-500">{order.message}</span>
            </KV>
          )}
          {order.orderStatusHistory && order.orderStatusHistory.length > 0 && (
            <KV label="Status History">
              <div className="flex flex-col gap-1 text-[0.8em]">
                {order.orderStatusHistory.map((entry, idx) => (
                  <span key={idx} className="inline-flex items-center">
                    <span className="text-ink-faint" style={{ minWidth: '90px' }}>
                      {formatTime(entry.lastUpdatedTimestamp)}
                    </span>
                    <span className={`font-medium ${statusTextClass(entry.orderStatus)}`}>{entry.orderStatus}</span>
                  </span>
                ))}
              </div>
            </KV>
          )}
        </KVTable>
      </Section>
    );
  };

  return (
    <Drawer
      open={show}
      onClose={onHide}
      title={
        <span className="flex items-center gap-2">
          <span className="font-bold">{trade.tradingSymbol}</span>
          {trade.direction === 'LONG' ? (
            <Badge tone="success">
              <BsArrowUp /> LONG
            </Badge>
          ) : (
            <Badge tone="danger">
              <BsArrowDown /> SHORT
            </Badge>
          )}
          {trade.state === 'ACTIVE' && <Badge tone="blue">Active</Badge>}
          {trade.state === 'OPEN' && <Badge tone="info">Open</Badge>}
          {trade.state === 'CANCELLED' && <Badge tone="danger">Cancelled</Badge>}
        </span>
      }
    >
      {/* Trade Summary */}
      <Section title="Trade Summary">
        <KVTable>
          <KV label="Trade ID">
            <span className="break-all text-[0.85em] font-medium">{trade.tradeID}</span>
          </KV>
          <KV label="Strategy">
            <Badge tone="neutral">{trade.strategy}</Badge>
          </KV>
          <KV label="Paper Trading">
            <Badge tone={trade.isPaperTrading ? 'info' : 'neutral'}>{trade.isPaperTrading ? 'true' : 'false'}</Badge>
          </KV>
          <KV label="Mock">
            <Badge tone={trade.isMock ? 'warning' : 'neutral'}>{trade.isMock ? 'true' : 'false'}</Badge>
          </KV>
          <KV label="State">
            <Badge tone={STATE_TONE[trade.state] ?? 'neutral'}>{trade.state}</Badge>
          </KV>
          <KV label="Group">{trade.group || '-'}</KV>
          <KV label="Product">{trade.productType}</KV>
          <KV label="Exchange / Segment">
            {trade.exchange} / {trade.segment}
          </KV>
          <KV label="Quantity">
            {trade.filledQuantity}/{trade.quantity}
          </KV>
          <KV label="Entry">
            {trade.entry?.toFixed(2)} {trade.requestedEntry > 0 && <small className="text-ink-faint">(Req: {trade.requestedEntry?.toFixed(2)})</small>}
          </KV>
          <KV label="Exit / CMP">{trade.exit > 0 ? trade.exit?.toFixed(2) : trade.cmp?.toFixed(2)}</KV>
          <KV label="Stop Loss">
            {trade.noStopLoss ? (
              <Badge tone="warning">No SL</Badge>
            ) : (
              <>
                {trade.stopLoss ? trade.stopLoss.toFixed(2) : '-'}
                {trade.initialStopLoss > 0 && trade.initialStopLoss !== trade.stopLoss && <small className="ml-1 text-ink-faint">(Initial: {trade.initialStopLoss?.toFixed(2)})</small>}
              </>
            )}
          </KV>
          <KV label="Target">{trade.target ? trade.target.toFixed(2) : '-'}</KV>
          <KV label="Start Time">{formatDateTime(trade.startTimestamp)}</KV>
          {(trade.state === 'OPEN' || trade.state === 'ACTIVE') && trade.exitTradeAt && <KV label="Will exit At">{formatDateTime(trade.exitTradeAt)}</KV>}
          {trade.endTimestamp && <KV label="End Time">{formatDateTime(trade.endTimestamp)}</KV>}
          {trade.exitReason && <KV label="Exit Reason">{trade.exitReason}</KV>}
          {trade.failureReason && (
            <KV label="Failure Reason">
              <span className="break-all text-danger-500">{trade.failureReason}</span>
            </KV>
          )}
          {trade.remarks && <KV label="Remarks">{trade.remarks}</KV>}
          {(trade.caFactor ?? 1) !== 1 && (
            <KV label="Corporate Action">
              <Badge tone="info">⑂ ×{trade.caFactor}</Badge>
              <small className="ml-1 text-ink-faint">
                Original: {trade.originalFilledQuantity ?? trade.originalQuantity} @ {trade.originalEntry?.toFixed(2)} →
                {' '}{trade.filledQuantity} @ {trade.entry?.toFixed(2)} (value unchanged)
              </small>
            </KV>
          )}
        </KVTable>
      </Section>

      {/* P&L Summary */}
      <Section title="P&L Summary">
        <div className="grid grid-cols-4 gap-2 p-3 text-center">
          <div>
            <div className="text-xs text-ink-faint">P/L</div>
            <div className="font-bold">
              <PnLDisplay value={trade.profitLoss} size="md" />
            </div>
          </div>
          <div>
            <div className="text-xs text-ink-faint">Charges</div>
            <div className="font-bold text-ink">{trade.charges?.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs text-ink-faint">Net P/L</div>
            <div className="font-bold">
              <PnLDisplay value={trade.netProfitLoss} size="md" />
            </div>
          </div>
          <div>
            <div className="text-xs text-ink-faint">P/L %</div>
            <div className="font-bold">
              <PnLDisplay value={trade.plPercentage} size="md" />
            </div>
          </div>
        </div>
      </Section>

      {/* Correlation IDs */}
      {(trade.hedgeCorrelationID || trade.hedgeTradeID || trade.hedgeDistancePercentage || trade.pairTradeCorrelationID) && (
        <Section title="Correlation">
          <KVTable>
            {trade.hedgeCorrelationID && (
              <KV label="Hedge Correlation">
                <span className="break-all text-[0.85em]">{trade.hedgeCorrelationID}</span>
              </KV>
            )}
            {trade.hedgeTradeID && (
              <KV label="Hedge Trade">
                <span className="break-all text-[0.85em]">{trade.hedgeTradeID}</span>
              </KV>
            )}
            {trade.hedgeDistancePercentage !== undefined && trade.hedgeDistancePercentage > 0 && (
              <KV label="Hedge Distance">
                <Badge tone="info">{trade.hedgeDistancePercentage}%</Badge>
              </KV>
            )}
            {trade.pairTradeCorrelationID && (
              <KV label="Pair Trade">
                <span className="break-all text-[0.85em]">{trade.pairTradeCorrelationID}</span>
              </KV>
            )}
          </KVTable>
        </Section>
      )}

      {/* Orders */}
      <h6 className="mb-3 border-b border-hairline pb-2 font-semibold text-ink">Orders</h6>
      {renderOrderCard(trade.order, 'Entry Order')}
      {renderOrderCard(trade.slOrder, 'Stop Loss Order')}
      {renderOrderCard(trade.targetOrder, 'Target Order')}
    </Drawer>
  );
};

export default TradeDetailsDrawer;
