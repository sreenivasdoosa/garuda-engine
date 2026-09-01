import { useMemo, useState } from 'react';
import { BsSearch, BsArrowClockwise, BsXCircle, BsClipboard, BsCheck2 } from 'react-icons/bs';
import { useNavigate } from 'react-router-dom';

import { useTradeLogPage } from '@/hooks/useTradeLog';
import UserSelect from '@/components/common/UserSelect';
import TablePagination from '@/components/common/TablePagination';
import type { TradeLogEntry, TradeLogEventCategory } from '@/types/tradeLog';
import { Badge, Button, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';

const formatTimestamp = (ts?: string): string => {
  if (!ts) return '';
  // Backend sends "yyyy-MM-dd HH:mm:ss.SSS" or Timestamp.toString() form.
  return ts.substring(0, 23);
};

// Small inline "copy-to-clipboard" icon button. Shows a checkmark briefly
// after successful copy so the user has feedback without a toast.
const CopyButton: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard denied or unavailable — no-op
    }
  };
  return (
    <span
      role="button"
      title={copied ? 'Copied!' : `Copy ${value}`}
      onClick={handleCopy}
      className={`ml-1 cursor-pointer text-xs ${copied ? 'text-success-500' : 'text-ink-faint hover:text-ink'}`}
    >
      {copied ? <BsCheck2 /> : <BsClipboard />}
    </span>
  );
};

const categoryTone = (cat?: TradeLogEventCategory): Tone => {
  switch (cat) {
    case 'ENTRY': return 'primary';
    case 'SL': return 'warning';
    case 'TARGET': return 'success';
    case 'HEDGE': return 'info';
    case 'EXIT': return 'neutral';
    case 'ERROR': return 'danger';
    case 'MODIFY': return 'neutral';
    default: return 'neutral';
  }
};

const ctrl = 'h-8 w-full rounded border border-hairline bg-card px-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60';
const cell = 'px-2 py-1.5';
const affixBtn = 'flex h-8 items-center justify-center rounded-r border border-l-0 border-hairline bg-raised px-2.5 text-ink-soft hover:text-ink';

const TradeLogPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    entries,
    pagination,
    filters,
    isLoading,
    isFetching,
    params,
    setPage,
    setPageSize,
    setFilter,
    setSearch,
    resetFilters,
    refresh,
  } = useTradeLogPage();

  const [searchInput, setSearchInput] = useState('');
  const [tradeIdInput, setTradeIdInput] = useState('');

  const handleSearch = () => setSearch(searchInput);
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };
  const handleTradeIdSubmit = () => setFilter('tradeId', tradeIdInput || undefined);
  const handleTradeIdKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleTradeIdSubmit();
  };

  const hasActiveFilters = useMemo(() => {
    return !!(
      params.tradeId ||
      params.username ||
      params.broker ||
      params.strategy ||
      params.tradingSymbol ||
      params.eventCategory ||
      params.eventType ||
      params.search ||
      params.startTime ||
      params.endTime
    );
  }, [params]);

  return (
    <div className="py-3">
      <div className="rounded-card border border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline p-3">
          <div className="flex items-center gap-2">
            <h5 className="mb-0 font-semibold text-ink">Trade Log</h5>
            {isFetching && <Spinner size="sm" />}
          </div>
          <Button variant="secondary" size="sm" onClick={refresh} disabled={isFetching}>
            <BsArrowClockwise className={isFetching ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>

        <div className="p-3">
          {/* Primary filter row */}
          <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-4 lg:grid-cols-12">
            <div className="flex lg:col-span-3">
              <input className={`${ctrl} rounded-r-none`} placeholder="Filter by trade ID..." value={tradeIdInput} onChange={(e) => setTradeIdInput(e.target.value)} onKeyDown={handleTradeIdKeyDown} />
              <button type="button" className={affixBtn} onClick={handleTradeIdSubmit} aria-label="Search trade ID">
                <BsSearch />
              </button>
            </div>
            <div className="flex lg:col-span-3">
              <input className={`${ctrl} rounded-r-none`} placeholder="Search message / symbol / orderId..." value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={handleSearchKeyDown} />
              <button type="button" className={affixBtn} onClick={handleSearch} aria-label="Search">
                <BsSearch />
              </button>
            </div>
            <div className="lg:col-span-2">
              <UserSelect value={params.username || ''} onChange={(username) => setFilter('username', username || undefined)} />
            </div>
            <div className="lg:col-span-3">
              <select className={ctrl} value={params.broker || ''} onChange={(e) => setFilter('broker', e.target.value || undefined)}>
                <option value="">All Brokers</option>
                {filters?.brokers?.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-1">
              {hasActiveFilters && (
                <Button
                  variant="danger"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    resetFilters();
                    setSearchInput('');
                    setTradeIdInput('');
                  }}
                  title="Clear filters"
                >
                  <BsXCircle />
                </Button>
              )}
            </div>
          </div>

          {/* Secondary filter row */}
          <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4">
            <select className={ctrl} value={params.strategy || ''} onChange={(e) => setFilter('strategy', e.target.value || undefined)}>
              <option value="">All Strategies</option>
              {filters?.strategies?.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select className={ctrl} value={params.tradingSymbol || ''} onChange={(e) => setFilter('tradingSymbol', e.target.value || undefined)}>
              <option value="">All Symbols</option>
              {filters?.tradingSymbols?.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select className={ctrl} value={params.eventCategory || ''} onChange={(e) => setFilter('eventCategory', e.target.value || undefined)}>
              <option value="">All Categories</option>
              {filters?.eventCategories?.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select className={ctrl} value={params.eventType || ''} onChange={(e) => setFilter('eventType', e.target.value || undefined)}>
              <option value="">All Event Types</option>
              {filters?.eventTypes?.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Pagination (top) */}
          {pagination && (
            <div className="mb-2">
              <TablePagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                totalCount={pagination.totalCount}
                totalPages={pagination.totalPages}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                itemLabel="events"
                loading={isLoading}
              />
            </div>
          )}

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`} style={{ width: '165px' }}>Timestamp</th>
                  <th className={`${cell} text-left`} style={{ width: '85px' }}>Category</th>
                  <th className={`${cell} text-left`} style={{ width: '170px' }}>Event</th>
                  <th className={`${cell} text-left`} style={{ width: '145px' }}>User</th>
                  <th className={`${cell} text-left`} style={{ width: '125px' }}>Strategy</th>
                  <th className={`${cell} text-left`} style={{ width: '125px' }}>Symbol</th>
                  <th className={`${cell} text-left`} style={{ width: '115px' }}>Trade</th>
                  <th className={`${cell} text-left`}>Message</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">
                      <Spinner size="sm" /> Loading...
                    </td>
                  </tr>
                ) : entries.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">No events found</td>
                  </tr>
                ) : (
                  entries.map((e: TradeLogEntry) => (
                    <tr key={e.id ?? `${e.tradeId}-${e.eventTimestamp}`} className="hover:bg-raised/50">
                      <td className={`${cell} whitespace-nowrap text-xs text-ink`}>{formatTimestamp(e.eventTimestamp)}</td>
                      <td className={cell}>
                        <Badge tone={categoryTone(e.eventCategory)}>{e.eventCategory}</Badge>
                      </td>
                      <td className={`${cell} text-xs text-ink`}>{e.eventType}</td>
                      <td className={`${cell} max-w-[145px] truncate text-xs text-ink`} title={e.username}>{e.username}</td>
                      <td className={`${cell} max-w-[125px] truncate text-xs text-ink`} title={e.strategy}>{e.strategy}</td>
                      <td className={`${cell} max-w-[125px] truncate text-xs text-ink`} title={e.tradingSymbol}>{e.tradingSymbol}</td>
                      <td className={`${cell} whitespace-nowrap font-mono text-[0.72rem]`}>
                        <span
                          role="button"
                          className="cursor-pointer text-primary-500"
                          title={`Open timeline for ${e.tradeId}`}
                          onClick={() => navigate(`/console/trade-log/${e.tradeId}`)}
                        >
                          {e.tradeId?.substring(0, 8)}
                        </span>
                        {e.tradeId && <CopyButton value={e.tradeId} />}
                      </td>
                      <td className={`${cell} text-xs text-ink`} title={e.message}>{e.message}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TradeLogPage;
