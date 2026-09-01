/**
 * OrderBookTable Component
 * Displays order book in a sortable table. Tailwind design system.
 * Reusable component for both admin and user portal.
 */

import React, { useState, useMemo } from 'react';
import { BsArrowUp, BsArrowDown, BsBoxArrowUpRight, BsSortDown, BsSortUp } from 'react-icons/bs';
import type { OrderDetails } from '@/types/terminal';
import { Badge } from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';

type SortField = 'orderPlacedTimestamp' | 'lastOrderUpdateTimestamp' | 'productType' | 'tradingSymbol' | 'orderType' | 'direction' | 'orderStatus' | 'isAlgoOrder';
type SortOrder = 'asc' | 'desc';

interface OrderBookTableProps {
  orders: OrderDetails[];
  onOrderClick?: (order: OrderDetails) => void;
  compact?: boolean;
  tradingMode?: 'live' | 'paper' | 'mixed';
}

const ctrl = 'h-8 w-full rounded border border-hairline bg-card px-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60';
const cell = 'px-2 py-1.5';

const statusTone = (status: string | undefined): Tone => {
  if (!status) return 'neutral';
  const s = status.toLowerCase();
  if (s.includes('complete')) return 'success';
  if (s.includes('reject') || s.includes('cancel')) return 'danger';
  if (s.includes('pending') || s.includes('trigger')) return 'warning';
  if (s.includes('open')) return 'info';
  return 'neutral';
};

const OrderBookTable: React.FC<OrderBookTableProps> = ({ orders, onOrderClick, compact = false, tradingMode = 'mixed' }) => {
  const [sortField, setSortField] = useState<SortField>('lastOrderUpdateTimestamp');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [filterProductType, setFilterProductType] = useState<string>('ALL');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterMode, setFilterMode] = useState<'ALL' | 'LIVE' | 'PAPER'>('ALL');
  const [filterOrderId, setFilterOrderId] = useState<string>('');
  const [filterSymbol, setFilterSymbol] = useState<string>('');

  const lockedMode: 'LIVE' | 'PAPER' | null = tradingMode === 'live' ? 'LIVE' : tradingMode === 'paper' ? 'PAPER' : null;
  const effectiveMode: 'ALL' | 'LIVE' | 'PAPER' = lockedMode ?? filterMode;

  const productTypes = useMemo(() => {
    if (!orders || orders.length === 0) return ['ALL'];
    const types = new Set(orders.map((o) => o.productType).filter(Boolean));
    return ['ALL', ...Array.from(types).sort()];
  }, [orders]);

  const statuses = useMemo(() => {
    if (!orders || orders.length === 0) return ['ALL'];
    const statusSet = new Set(orders.map((o) => o.orderStatus).filter(Boolean));
    return ['ALL', ...Array.from(statusSet).sort()];
  }, [orders]);

  const filteredAndSortedOrders = useMemo(() => {
    if (!orders || orders.length === 0) return [];
    let filtered = [...orders];

    if (filterOrderId.trim()) filtered = filtered.filter((o) => o.orderId === filterOrderId.trim());
    if (filterSymbol.trim()) {
      const symbolLower = filterSymbol.trim().toLowerCase();
      filtered = filtered.filter((o) => o.tradingSymbol?.toLowerCase().includes(symbolLower));
    }
    if (filterProductType !== 'ALL') filtered = filtered.filter((o) => o.productType === filterProductType);
    if (filterStatus !== 'ALL') filtered = filtered.filter((o) => o.orderStatus === filterStatus);
    if (effectiveMode !== 'ALL') filtered = filtered.filter((o) => (effectiveMode === 'PAPER' ? !!o.isPaperTrading : !o.isPaperTrading));

    filtered.sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';
      switch (sortField) {
        case 'orderPlacedTimestamp':
          aVal = a.orderPlacedTimestamp || 0;
          bVal = b.orderPlacedTimestamp || 0;
          break;
        case 'lastOrderUpdateTimestamp':
          aVal = a.lastOrderUpdateTimestamp || 0;
          bVal = b.lastOrderUpdateTimestamp || 0;
          break;
        case 'productType':
          aVal = a.productType || '';
          bVal = b.productType || '';
          break;
        case 'tradingSymbol':
          aVal = a.tradingSymbol || '';
          bVal = b.tradingSymbol || '';
          break;
        case 'orderType':
          aVal = a.orderType || '';
          bVal = b.orderType || '';
          break;
        case 'direction':
          aVal = a.direction || '';
          bVal = b.direction || '';
          break;
        case 'orderStatus':
          aVal = a.orderStatus || '';
          bVal = b.orderStatus || '';
          break;
        case 'isAlgoOrder':
          aVal = a.isAlgoOrder ? 1 : 0;
          bVal = b.isAlgoOrder ? 1 : 0;
          break;
      }
      if (typeof aVal === 'number' && typeof bVal === 'number') return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
      const comparison = String(aVal).localeCompare(String(bVal));
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [orders, filterOrderId, filterSymbol, filterProductType, filterStatus, effectiveMode, sortField, sortOrder]);

  const formatTime = (timestamp: number | undefined): string => {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) return null;
    return sortOrder === 'asc' ? <BsSortUp className="ml-1 inline" /> : <BsSortDown className="ml-1 inline" />;
  };

  const sortTh = (label: string, field: SortField) => (
    <th className={`${cell} cursor-pointer text-left`} onClick={() => handleSort(field)}>
      {label} {renderSortIcon(field)}
    </th>
  );

  if (!orders || orders.length === 0) {
    return <p className="py-3 text-center text-ink-soft">No orders in the order book</p>;
  }

  return (
    <div>
      {/* Filters */}
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6">
        <input className={ctrl} type="text" placeholder="Order ID" value={filterOrderId} onChange={(e) => setFilterOrderId(e.target.value)} />
        <input className={ctrl} type="text" placeholder="Symbol" value={filterSymbol} onChange={(e) => setFilterSymbol(e.target.value)} />
        <select className={ctrl} value={filterProductType} onChange={(e) => setFilterProductType(e.target.value)}>
          {productTypes.map((type) => (
            <option key={type} value={type}>
              {type === 'ALL' ? 'All Products' : type}
            </option>
          ))}
        </select>
        <select className={ctrl} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          {statuses.map((status) => (
            <option key={status} value={status}>
              {status === 'ALL' ? 'All Statuses' : status}
            </option>
          ))}
        </select>
        <select
          className={ctrl}
          value={effectiveMode}
          onChange={(e) => setFilterMode(e.target.value as 'ALL' | 'LIVE' | 'PAPER')}
          disabled={lockedMode !== null}
          title={lockedMode !== null ? `Locked to ${lockedMode} by the terminal mode selector` : 'Live, paper, or all orders'}
        >
          <option value="ALL">All Orders</option>
          <option value="LIVE">Live</option>
          <option value="PAPER">Paper</option>
        </select>
        <div className="col-span-2 flex items-center text-xs text-ink-soft md:col-span-1 md:justify-end">
          Showing {filteredAndSortedOrders.length} of {orders?.length || 0} orders
        </div>
      </div>

      {/* Table */}
      <div style={{ maxHeight: compact ? '400px' : '70vh', overflowY: 'auto' }} className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-[1] bg-raised text-ink-faint">
            <tr>
              <th className={`${cell} text-left`}>#</th>
              <th className={`${cell} text-left`}>Order ID</th>
              {sortTh('Entry Time', 'orderPlacedTimestamp')}
              {sortTh('Last Update', 'lastOrderUpdateTimestamp')}
              {sortTh('Symbol', 'tradingSymbol')}
              {sortTh('Product', 'productType')}
              {sortTh('Type', 'orderType')}
              {sortTh('Dir', 'direction')}
              <th className={`${cell} text-right`}>Qty</th>
              <th className={`${cell} text-right`}>Filled</th>
              <th className={`${cell} text-right`}>Price</th>
              <th className={`${cell} text-right`}>Avg Price</th>
              {sortTh('Status', 'orderStatus')}
              {sortTh('Source', 'isAlgoOrder')}
              {onOrderClick && <th className={`${cell} text-left`}>Details</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {filteredAndSortedOrders.map((order, idx) => (
              <tr key={order.orderId || idx} className={onOrderClick ? 'cursor-pointer hover:bg-raised/50' : 'hover:bg-raised/50'} onClick={() => onOrderClick?.(order)}>
                <td className={`${cell} text-ink-faint`}>{idx + 1}</td>
                <td className={`${cell} whitespace-nowrap`}>
                  <code className="text-[0.7rem] text-ink" title={order.orderId}>
                    {order.orderId || '-'}
                  </code>
                </td>
                <td className={`${cell} text-ink`}>{formatTime(order.orderPlacedTimestamp)}</td>
                <td className={`${cell} text-ink`}>{formatTime(order.lastOrderUpdateTimestamp)}</td>
                <td className={`${cell} font-medium text-ink`}>
                  {order.tradingSymbol}
                  <Badge tone={order.isPaperTrading ? 'info' : 'neutral'} className="ml-1">
                    {order.isPaperTrading ? 'P' : 'L'}
                  </Badge>
                </td>
                <td className={cell}>
                  <Badge tone="neutral">{order.productType}</Badge>
                </td>
                <td className={cell}>
                  <Badge tone="info">{order.orderType}</Badge>
                </td>
                <td className={cell}>
                  {order.direction === 'LONG' ? (
                    <Badge tone="success">
                      <BsArrowUp /> B
                    </Badge>
                  ) : (
                    <Badge tone="danger">
                      <BsArrowDown /> S
                    </Badge>
                  )}
                </td>
                <td className={`${cell} text-right tabular-nums text-ink`}>{order.quantity}</td>
                <td className={`${cell} text-right tabular-nums`}>
                  <span className={order.filledQuantity > 0 ? 'text-success-500' : 'text-ink'}>{order.filledQuantity}</span>
                </td>
                <td className={`${cell} text-right tabular-nums text-ink`}>{order.price?.toFixed(2)}</td>
                <td className={`${cell} text-right tabular-nums text-ink`}>{order.averagePrice > 0 ? order.averagePrice.toFixed(2) : '-'}</td>
                <td className={cell}>
                  <Badge tone={statusTone(order.orderStatus)}>{order.orderStatus || '-'}</Badge>
                </td>
                <td className={cell}>{order.isAlgoOrder ? <Badge tone="primary">Algo</Badge> : <Badge tone="neutral">External</Badge>}</td>
                {onOrderClick && (
                  <td className={cell}>
                    <span className="flex items-center gap-1 text-primary-500">
                      <BsBoxArrowUpRight size={12} />
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default OrderBookTable;
