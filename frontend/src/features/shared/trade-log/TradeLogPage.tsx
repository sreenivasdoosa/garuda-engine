/**
 * Trade Log: what the engine did with each trade, across every account.
 *
 * One row per event, freshest first, filtered in the database so the
 * count agrees with the page. A trade id opens its timeline, which is
 * where one trade's story reads top to bottom.
 */

import { useMemo, useState } from 'react';
import { BsArrowClockwise, BsListUl, BsSearch, BsXCircle } from 'react-icons/bs';
import { Link } from 'react-router-dom';

import { PageHeader } from '@/components/common';
import TablePagination from '@/components/common/TablePagination';
import { Badge, Button, Spinner } from '@/components/ui';
import { useTradeLogPage } from '@/hooks/useTradeLog';
import type { TradeLogEntry } from '@/types/tradeLog';
import { CopyButton, categoryTone, formatWhen } from './tradeLogShared';

const label = 'mb-1 block text-xs text-ink-soft';
const ctrl =
  'h-8 w-full rounded border border-hairline bg-card px-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus:border-primary-500/60';
const cell = 'px-2 py-1.5';
const affixBtn =
  'flex h-8 items-center justify-center rounded-r border border-l-0 border-hairline bg-raised px-2.5 text-ink-soft hover:text-ink';

const TradeLogPage: React.FC = () => {
  const {
    entries,
    pagination,
    filters,
    isLoading,
    isFetching,
    error,
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

  const typesOffered = useMemo(() => {
    if (!filters) return [];
    if (params.eventCategory && filters.typesByCategory[params.eventCategory]) {
      return filters.typesByCategory[params.eventCategory];
    }
    return filters.eventTypes;
  }, [filters, params.eventCategory]);

  const hasActiveFilters = useMemo(
    () =>
      !!(
        params.tradeId ||
        params.tradingClientId ||
        params.strategy ||
        params.tradingSymbol ||
        params.eventCategory ||
        params.eventType ||
        params.search ||
        params.startTime ||
        params.endTime
      ),
    [params],
  );

  const clearAll = () => {
    resetFilters();
    setSearchInput('');
    setTradeIdInput('');
  };

  return (
    <div className="py-3">
      <PageHeader
        title="Trade Log"
        subtitle="Every event in every trade's life, as the engine wrote it"
        icon={<BsListUl />}
        actions={
          <Button variant="secondary" size="sm" onClick={refresh} disabled={isFetching}>
            <BsArrowClockwise className={isFetching ? 'animate-spin' : ''} /> Refresh
          </Button>
        }
      />

      <div className="rounded-card border border-hairline bg-card">
        <div className="p-3">
          {/* Who and what */}
          <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-12">
            <div className="lg:col-span-3">
              <span className={label}>Trade id</span>
              <div className="flex">
                <input
                  className={`${ctrl} rounded-r-none font-mono`}
                  placeholder="exact id"
                  value={tradeIdInput}
                  onChange={(e) => setTradeIdInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && setFilter('tradeId', tradeIdInput.trim())}
                />
                <button type="button" className={affixBtn} onClick={() => setFilter('tradeId', tradeIdInput.trim())} aria-label="Filter by trade id">
                  <BsSearch />
                </button>
              </div>
            </div>
            <div className="lg:col-span-4">
              <span className={label}>Search</span>
              <div className="flex">
                <input
                  className={`${ctrl} rounded-r-none`}
                  placeholder="message, symbol, order id, strategy or account"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && setSearch(searchInput.trim())}
                />
                <button type="button" className={affixBtn} onClick={() => setSearch(searchInput.trim())} aria-label="Search">
                  <BsSearch />
                </button>
              </div>
            </div>
            <div className="lg:col-span-3">
              <span className={label}>Trading client</span>
              <select className={ctrl} value={params.tradingClientId ?? ''} onChange={(e) => setFilter('tradingClientId', e.target.value)}>
                <option value="">All accounts</option>
                {filters?.tradingClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                    {c.broker ? ` (${c.broker})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="lg:col-span-2 flex items-end">
              {hasActiveFilters && (
                <Button variant="danger" size="sm" className="w-full" onClick={clearAll} title="Clear every filter">
                  <BsXCircle /> Clear
                </Button>
              )}
            </div>
          </div>

          {/* Which events, when */}
          <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-3 lg:grid-cols-6">
            <div>
              <span className={label}>Strategy</span>
              <select className={ctrl} value={params.strategy ?? ''} onChange={(e) => setFilter('strategy', e.target.value)}>
                <option value="">All strategies</option>
                {filters?.strategies.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <span className={label}>Symbol</span>
              <select className={ctrl} value={params.tradingSymbol ?? ''} onChange={(e) => setFilter('tradingSymbol', e.target.value)}>
                <option value="">All symbols</option>
                {filters?.tradingSymbols.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <span className={label}>Category</span>
              <select
                className={ctrl}
                value={params.eventCategory ?? ''}
                onChange={(e) => {
                  setFilter('eventCategory', e.target.value);
                  setFilter('eventType', undefined);
                }}
              >
                <option value="">All categories</option>
                {filters?.eventCategories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <span className={label}>Event</span>
              <select className={ctrl} value={params.eventType ?? ''} onChange={(e) => setFilter('eventType', e.target.value)}>
                <option value="">All events</option>
                {typesOffered.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <span className={label}>From</span>
              <input type="date" className={ctrl} value={params.startTime ?? ''} onChange={(e) => setFilter('startTime', e.target.value)} />
            </div>
            <div>
              <span className={label}>To</span>
              <input type="date" className={ctrl} value={params.endTime ?? ''} onChange={(e) => setFilter('endTime', e.target.value)} />
            </div>
          </div>

          {error && (
            <div className="mb-3 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
              {(error as Error).message}
            </div>
          )}

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

          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`} style={{ width: '170px' }}>When</th>
                  <th className={`${cell} text-left`} style={{ width: '85px' }}>Category</th>
                  <th className={`${cell} text-left`} style={{ width: '180px' }}>Event</th>
                  <th className={`${cell} text-left`} style={{ width: '150px' }}>Account</th>
                  <th className={`${cell} text-left`} style={{ width: '120px' }}>Strategy</th>
                  <th className={`${cell} text-left`} style={{ width: '150px' }}>Symbol</th>
                  <th className={`${cell} text-left`} style={{ width: '120px' }}>Trade</th>
                  <th className={`${cell} text-left`}>What happened</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">
                      <Spinner size="sm" /> Loading…
                    </td>
                  </tr>
                ) : entries.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">
                      {hasActiveFilters ? 'Nothing matches these filters.' : 'Nothing logged yet. The engine writes a row for every event in a trade’s life.'}
                    </td>
                  </tr>
                ) : (
                  entries.map((e: TradeLogEntry) => (
                    <tr key={e.id} className="hover:bg-raised/50">
                      <td className={`${cell} whitespace-nowrap text-xs text-ink`}>{formatWhen(e.eventTimestamp)}</td>
                      <td className={cell}>
                        <Badge tone={categoryTone(e.eventCategory)}>{e.eventCategory}</Badge>
                      </td>
                      <td className={`${cell} text-xs text-ink`}>{e.eventType}</td>
                      <td className={`${cell} max-w-[150px] truncate text-xs text-ink`} title={e.tradingClient ?? e.tradingClientId}>
                        {e.tradingClient ?? e.tradingClientId}
                        {e.broker && <span className="text-ink-faint"> · {e.broker}</span>}
                      </td>
                      <td className={`${cell} max-w-[120px] truncate text-xs text-ink`} title={e.strategy ?? ''}>{e.strategy}</td>
                      <td className={`${cell} max-w-[150px] truncate font-mono text-xs text-ink`} title={e.tradingSymbol ?? ''}>{e.tradingSymbol}</td>
                      <td className={`${cell} whitespace-nowrap font-mono text-[0.72rem]`}>
                        <Link to={`/console/trade-log/${encodeURIComponent(e.tradeId)}`} className="text-primary-500" title={`Timeline of ${e.tradeId}`}>
                          {e.tradeId.length > 12 ? `${e.tradeId.substring(0, 12)}…` : e.tradeId}
                        </Link>
                        <CopyButton value={e.tradeId} />
                      </td>
                      <td className={`${cell} text-xs text-ink`} title={e.errorMessage ?? e.message ?? ''}>
                        {e.message}
                        {e.errorMessage && e.errorMessage !== e.message && !(e.message ?? '').includes(e.errorMessage) && (
                          <span className="text-danger-500"> — {e.errorMessage}</span>
                        )}
                      </td>
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
