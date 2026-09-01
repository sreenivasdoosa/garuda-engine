/**
 * OrderDetailsDrawer Component
 * Side panel drawer showing full order details. Tailwind design system.
 * Reusable component for both admin and user portal.
 */

import React from 'react';
import { BsArrowUp, BsArrowDown } from 'react-icons/bs';
import type { OrderDetails } from '@/types/terminal';
import { Badge, Drawer } from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';

interface OrderDetailsDrawerProps {
  show: boolean;
  onHide: () => void;
  order: OrderDetails | null;
}

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

const OrderDetailsDrawer: React.FC<OrderDetailsDrawerProps> = ({ show, onHide, order }) => {
  if (!order) return null;

  const formatTime = (timestamp: number | null | undefined): string => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    const s = date.getSeconds().toString().padStart(2, '0');
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
  };

  const formatDateTime = (timestamp: number | null | undefined): string => {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };

  const dirBadge =
    order.direction === 'LONG' ? (
      <Badge tone="success">
        <BsArrowUp /> BUY
      </Badge>
    ) : (
      <Badge tone="danger">
        <BsArrowDown /> SELL
      </Badge>
    );

  return (
    <Drawer
      open={show}
      onClose={onHide}
      title={
        <span className="flex items-center gap-2">
          <span className="font-bold">{order.tradingSymbol}</span>
          {dirBadge}
          <Badge tone={statusTone(order.orderStatus)}>{order.orderStatus || '-'}</Badge>
        </span>
      }
    >
      {/* Order Summary */}
      <Section title="Order Summary">
        <KVTable>
          <KV label="Order ID">
            <span className="break-all text-[0.85em] font-medium">{order.orderId}</span>
          </KV>
          <KV label="Exchange Order ID">{order.exchangeOrderId || '-'}</KV>
          <KV label="Exchange / Segment">
            {order.exchange} {order.segment ? `/ ${order.segment}` : ''}
          </KV>
          <KV label="Product Type">
            <Badge tone="neutral">{order.productType}</Badge>
          </KV>
          <KV label="Order Type">
            <Badge tone="info">{order.orderType}</Badge>
          </KV>
          <KV label="Direction">{dirBadge}</KV>
        </KVTable>
      </Section>

      {/* Price Details */}
      <Section title="Price Details">
        <KVTable>
          <KV label="Price">{order.price?.toFixed(2)}</KV>
          {order.triggerPrice > 0 && <KV label="Trigger Price">{order.triggerPrice?.toFixed(2)}</KV>}
          <KV label="Average Price">{order.averagePrice?.toFixed(2)}</KV>
        </KVTable>
      </Section>

      {/* Quantity Details */}
      <Section title="Quantity Details">
        <KVTable>
          <KV label="Total Quantity">{order.quantity}</KV>
          <KV label="Filled Quantity">
            <span className="font-medium text-success-500">{order.filledQuantity}</span>
          </KV>
          <KV label="Pending Quantity">
            <span className={order.pendingQuantity > 0 ? 'font-medium text-warning-500' : ''}>{order.pendingQuantity}</span>
          </KV>
          {order.disclosedQuantity != null && order.disclosedQuantity > 0 && <KV label="Disclosed Quantity">{order.disclosedQuantity}</KV>}
        </KVTable>
      </Section>

      {/* Timestamps */}
      <Section title="Timestamps">
        <KVTable>
          <KV label="Order Placed">{formatDateTime(order.orderPlacedTimestamp)}</KV>
          {order.orderExecutedTimestamp && <KV label="Order Executed">{formatDateTime(order.orderExecutedTimestamp)}</KV>}
          <KV label="Last Update">{formatDateTime(order.lastOrderUpdateTimestamp)}</KV>
          {order.exchangeLastUpdateTimestamp && <KV label="Exchange Update">{formatDateTime(order.exchangeLastUpdateTimestamp)}</KV>}
        </KVTable>
      </Section>

      {/* Additional Info */}
      <Section title="Additional Info">
        <KVTable>
          <KV label="Source">{order.isAlgoOrder ? <Badge tone="primary">Algo Order</Badge> : <Badge tone="neutral">External Order</Badge>}</KV>
          {order.systemOrderId && (
            <KV label="System Order ID">
              <span className="break-all text-[0.85em]">{order.systemOrderId}</span>
            </KV>
          )}
          {order.tradeID && (
            <KV label="Trade ID">
              <span className="break-all text-[0.85em]">{order.tradeID}</span>
            </KV>
          )}
          {order.strategy && (
            <KV label="Strategy">
              <Badge tone="neutral">{order.strategy}</Badge>
            </KV>
          )}
          {order.parentOrderId && (
            <KV label="Parent Order ID">
              <span className="break-all text-[0.85em]">{order.parentOrderId}</span>
            </KV>
          )}
          {order.numModifyRequests !== undefined && order.numModifyRequests > 0 && <KV label="Modify Requests">{order.numModifyRequests}</KV>}
        </KVTable>
      </Section>

      {/* Message */}
      {order.message && (
        <Section title="Message">
          <p className="mb-0 px-3 py-2 text-danger-500">{order.message}</p>
        </Section>
      )}

      {/* Status History */}
      {order.orderStatusHistory && order.orderStatusHistory.length > 0 && (
        <Section title="Status History">
          <table className="w-full text-sm">
            <thead className="bg-raised text-xs uppercase text-ink-faint">
              <tr>
                <th className="px-3 py-1.5 text-left">Time</th>
                <th className="px-3 py-1.5 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {order.orderStatusHistory.map((entry, idx) => (
                <tr key={idx}>
                  <td className="px-3 py-1.5 text-ink-faint">{formatTime(entry.lastUpdatedTimestamp)}</td>
                  <td className={`px-3 py-1.5 font-medium ${statusTextClass(entry.orderStatus)}`}>{entry.orderStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Order Type History */}
      {order.orderTypeHistory && order.orderTypeHistory.length > 1 && (
        <Section title="Order Type History">
          <table className="w-full text-sm">
            <thead className="bg-raised text-xs uppercase text-ink-faint">
              <tr>
                <th className="px-3 py-1.5 text-left">Time</th>
                <th className="px-3 py-1.5 text-left">Order Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {order.orderTypeHistory.map((entry, idx) => (
                <tr key={idx}>
                  <td className="px-3 py-1.5 text-ink-faint">{formatTime(entry.lastUpdatedTimestamp)}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone="info">{entry.orderType}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </Drawer>
  );
};

export default OrderDetailsDrawer;
