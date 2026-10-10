/**
 * One trade's timeline: its events oldest first, down a rail.
 *
 * The summary is read off the events themselves -- the first says who and
 * what, the last says whether it is over -- so the page needs nothing but
 * the log. The Terminal links here from every trade it shows.
 */

import { useMemo } from 'react';
import { BsArrowClockwise, BsArrowLeft } from 'react-icons/bs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import { Badge, Button, Spinner } from '@/components/ui';
import { tradeLogService } from '@/services/trade-log/tradeLogService';
import type { TradeLogEntry } from '@/types/tradeLog';
import { CopyButton, categoryColorHex, categoryTone, formatClock, formatPrice, formatWhen } from './tradeLogShared';

const kv = 'text-xs text-ink-soft';

const ENDS_IT = new Set(['TRADE_COMPLETED', 'TRADE_CANCELLED', 'ENTRY_FAILED', 'ENTRY_REJECTED', 'EXIT_FAILED']);

const TradeTimelinePage: React.FC = () => {
  const { tradeId } = useParams<{ tradeId: string }>();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['trade-log', 'trade', tradeId],
    queryFn: () => tradeLogService.getByTradeId(tradeId ?? ''),
    enabled: !!tradeId,
    staleTime: 5000,
    refetchInterval: 15000,
  });

  const entries = query.data ?? [];
  const first = entries[0];
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;

  const summary = useMemo(() => {
    if (!first || !last) return null;
    const ending = [...entries].reverse().find((e) => ENDS_IT.has(e.eventType));
    return {
      account: first.tradingClient ?? first.tradingClientId,
      broker: first.broker,
      strategy: first.strategy,
      symbol: first.tradingSymbol,
      hedgeCorrelationId: first.hedgeCorrelationId,
      startedAt: first.eventTimestamp,
      endedAt: ending ? ending.eventTimestamp : null,
      endedWith: ending?.eventType ?? null,
      endingMessage: ending?.message ?? null,
      endedBadly: ending ? ending.eventType !== 'TRADE_COMPLETED' : false,
    };
  }, [entries, first, last]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['trade-log', 'trade', tradeId] });

  if (!tradeId) {
    return (
      <div className="py-3">
        <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
          A trade id is required.
        </div>
      </div>
    );
  }

  return (
    <div className="py-3">
      <div className="mb-3 flex items-center justify-between">
        <Link to="/console/trade-log" className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <BsArrowLeft /> Trade Log
        </Link>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={query.isFetching}>
          <BsArrowClockwise className={query.isFetching ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      <div className="mb-3 rounded-card border border-hairline bg-card p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
          <div className="col-span-2 md:col-span-1">
            <div className={kv}>Trade</div>
            <div className="break-all font-mono text-sm text-ink">
              {tradeId}
              <CopyButton value={tradeId} className="ml-1.5 text-sm" />
            </div>
          </div>
          <div>
            <div className={kv}>Account</div>
            <div className="text-ink">
              {summary?.account ?? '—'}
              {summary?.broker && <span className="text-ink-faint"> · {summary.broker}</span>}
            </div>
          </div>
          <div>
            <div className={kv}>Strategy</div>
            <div className="text-ink">{summary?.strategy ?? '—'}</div>
          </div>
          <div>
            <div className={kv}>Symbol</div>
            <div className="font-mono text-ink">{summary?.symbol ?? '—'}</div>
          </div>
          <div className="col-span-2 md:col-span-1">
            <div className={kv}>Life</div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <span>
                {summary?.startedAt ? formatWhen(summary.startedAt) : '—'}
                {' → '}
                {summary?.endedAt ? formatClock(summary.endedAt) : summary ? 'still live' : '—'}
              </span>
              {summary?.endedWith && (
                <Badge tone={summary.endedBadly ? 'danger' : 'success'}>{summary.endedWith}</Badge>
              )}
            </div>
          </div>
        </div>
        {summary?.hedgeCorrelationId && (
          <div className="mt-2">
            <span className={kv}>Hedge correlation: </span>
            <code className="text-xs text-ink">{summary.hedgeCorrelationId}</code>
          </div>
        )}
        {summary?.endingMessage && (
          <div className={`mt-2 text-sm ${summary.endedBadly ? 'text-danger-500' : 'text-success-500'}`}>{summary.endingMessage}</div>
        )}
      </div>

      <div className="rounded-card border border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline p-3">
          <h5 className="mb-0 font-semibold text-ink">Timeline</h5>
          <small className={kv}>{entries.length} events</small>
        </div>
        <div className="p-4">
          {query.isLoading ? (
            <div className="py-4 text-center text-ink-soft">
              <Spinner size="sm" /> Loading…
            </div>
          ) : query.error ? (
            <div className="py-4 text-center text-danger-500">{(query.error as Error).message}</div>
          ) : entries.length === 0 ? (
            <div className="py-4 text-center text-ink-soft">
              No events recorded for this trade. Either it predates the log, or the id is not one the engine wrote.
            </div>
          ) : (
            <div className="relative pl-8">
              <div className="absolute bottom-2 top-2 w-0.5 bg-hairline" style={{ left: '0.85rem' }} />
              {entries.map((e: TradeLogEntry) => (
                <div key={e.id} className="relative mb-3">
                  <div
                    style={{
                      position: 'absolute',
                      left: '-1.4rem',
                      top: '0.35rem',
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      background: categoryColorHex(e.eventCategory),
                      border: '2px solid rgb(var(--c-card))',
                      boxShadow: '0 0 0 1px ' + categoryColorHex(e.eventCategory),
                    }}
                  />
                  <div className="rounded border border-hairline bg-raised p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge tone={categoryTone(e.eventCategory)}>{e.eventCategory}</Badge>
                        <strong className="text-sm text-ink">{e.eventType}</strong>
                      </div>
                      <small className={kv} title={formatWhen(e.eventTimestamp)}>
                        {formatClock(e.eventTimestamp)}
                      </small>
                    </div>

                    {e.message && <div className="mt-1 text-sm text-ink">{e.message}</div>}

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {e.orderId && (
                        <small className={kv}>
                          Order <code className="text-xs text-ink">{e.orderId}</code>
                          {e.orderType && <Badge tone="neutral" className="ml-1">{e.orderType}</Badge>}
                          {e.orderStatus && <Badge tone="neutral" className="ml-1">{e.orderStatus}</Badge>}
                        </small>
                      )}
                      {e.price && (
                        <small className={kv}>
                          price <strong className="font-mono text-ink">{formatPrice(e.price)}</strong>
                        </small>
                      )}
                      {e.slPrice && (
                        <small className={kv}>
                          stop <strong className="font-mono text-ink">{formatPrice(e.slPrice)}</strong>
                        </small>
                      )}
                      {e.targetPrice && (
                        <small className={kv}>
                          target <strong className="font-mono text-ink">{formatPrice(e.targetPrice)}</strong>
                        </small>
                      )}
                      {e.quantity !== null && (
                        <small className={kv}>
                          qty <strong className="font-mono text-ink">{e.filledQuantity ?? 0}/{e.quantity}</strong>
                        </small>
                      )}
                    </div>

                    {e.errorMessage && !(e.message ?? '').includes(e.errorMessage) && (
                      <div className="mt-1 text-xs text-danger-500">{e.errorMessage}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TradeTimelinePage;
