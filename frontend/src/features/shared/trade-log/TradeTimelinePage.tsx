import { useMemo, useState } from 'react';
import { BsArrowLeft, BsArrowClockwise, BsClipboard, BsCheck2 } from 'react-icons/bs';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { tradeLogService } from '@/services/trade-log/tradeLogService';
import type { TradeLogEntry, TradeLogEventCategory } from '@/types/tradeLog';
import { Badge, Button, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';

const formatTimestamp = (ts?: string): string => {
  if (!ts) return '';
  return ts.substring(0, 23);
};

const formatTimeOnly = (ts?: string): string => {
  if (!ts) return '';
  const parts = ts.split(' ');
  return parts.length > 1 ? parts[1].substring(0, 12) : ts.substring(0, 12);
};

const CopyButton: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };
  return (
    <span
      role="button"
      title={copied ? 'Copied!' : `Copy ${value}`}
      onClick={handleCopy}
      className={`ml-1.5 cursor-pointer text-sm ${copied ? 'text-success-500' : 'text-ink-faint hover:text-ink'}`}
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

// Dot colors on the timeline — kept as fixed semantic hues so the vertical rail
// reads at a glance regardless of theme.
const categoryColorHex = (cat?: TradeLogEventCategory): string => {
  switch (cat) {
    case 'ENTRY': return '#6b8cff';
    case 'SL': return '#ffc107';
    case 'TARGET': return '#22c55e';
    case 'HEDGE': return '#0dcaf0';
    case 'EXIT': return '#94a3b8';
    case 'ERROR': return '#ef4444';
    case 'MODIFY': return '#94a3b8';
    default: return '#94a3b8';
  }
};

const kv = 'text-xs text-ink-soft';

const TradeTimelinePage: React.FC = () => {
  const { tradeId } = useParams<{ tradeId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['trade-log', 'trade', tradeId],
    queryFn: () => tradeLogService.getByTradeId(tradeId ?? ''),
    enabled: !!tradeId,
    staleTime: 5000,
  });

  const entries = query.data ?? [];
  const first = entries[0];
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;

  const summary = useMemo(() => {
    if (entries.length === 0) return null;
    const completedRow = [...entries].reverse().find((e) => e.eventType === 'TRADE_COMPLETED');
    return {
      username: first?.username,
      broker: first?.broker,
      strategy: first?.strategy,
      symbol: first?.tradingSymbol,
      hedgeCorrelationId: first?.hedgeCorrelationId,
      startedAt: first?.eventTimestamp,
      endedAt: last?.eventTimestamp,
      completed: !!completedRow,
      completionMessage: completedRow?.message,
    };
  }, [entries, first, last]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['trade-log', 'trade', tradeId] });
  };

  if (!tradeId) {
    return (
      <div className="py-3">
        <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">Trade ID is required</div>
      </div>
    );
  }

  return (
    <div className="py-3">
      <div className="mb-3 flex items-center justify-between">
        <Button variant="secondary" size="sm" onClick={() => navigate('/console/trade-log')}>
          <BsArrowLeft /> Back to Trade Log
        </Button>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={query.isFetching}>
          <BsArrowClockwise className={query.isFetching ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {/* Summary card */}
      <div className="mb-3 rounded-card border border-hairline bg-card p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
          <div>
            <div className={kv}>Trade ID</div>
            <div className="break-all font-mono text-sm text-ink">
              {tradeId}
              <CopyButton value={tradeId} />
            </div>
          </div>
          <div>
            <div className={kv}>User · Broker</div>
            <div className="text-ink">{summary?.username ?? '—'} · {summary?.broker ?? '—'}</div>
          </div>
          <div>
            <div className={kv}>Strategy</div>
            <div className="text-ink">{summary?.strategy ?? '—'}</div>
          </div>
          <div>
            <div className={kv}>Symbol</div>
            <div className="text-ink">{summary?.symbol ?? '—'}</div>
          </div>
          <div className="col-span-2 md:col-span-1">
            <div className={kv}>Lifecycle</div>
            <div className="flex items-center gap-2 text-ink">
              <span>
                {summary?.startedAt ? formatTimeOnly(summary.startedAt) : '—'}
                {' → '}
                {summary?.endedAt ? formatTimeOnly(summary.endedAt) : '(ongoing)'}
              </span>
              {summary?.completed && <Badge tone="success">COMPLETED</Badge>}
            </div>
          </div>
        </div>
        {summary?.hedgeCorrelationId && (
          <div className="mt-2">
            <span className={kv}>Hedge correlation: </span>
            <code className="text-xs text-ink">{summary.hedgeCorrelationId}</code>
          </div>
        )}
        {summary?.completionMessage && (
          <div className="mt-2 text-sm text-success-500">{summary.completionMessage}</div>
        )}
      </div>

      {/* Timeline */}
      <div className="rounded-card border border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline p-3">
          <h5 className="mb-0 font-semibold text-ink">Event Timeline</h5>
          <small className={kv}>{entries.length} events</small>
        </div>
        <div className="p-4">
          {query.isLoading ? (
            <div className="py-4 text-center text-ink-soft">
              <Spinner size="sm" /> Loading...
            </div>
          ) : entries.length === 0 ? (
            <div className="py-4 text-center text-ink-soft">No events recorded for this trade</div>
          ) : (
            <div className="relative pl-8">
              {/* Vertical rail */}
              <div className="absolute bottom-2 top-2 w-0.5 bg-hairline" style={{ left: '0.85rem' }} />

              {entries.map((e: TradeLogEntry, idx: number) => (
                <div key={e.id ?? `${idx}-${e.eventTimestamp}`} className="relative mb-3">
                  {/* Dot */}
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
                  {/* Event card */}
                  <div className="rounded border border-hairline bg-raised p-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge tone={categoryTone(e.eventCategory)}>{e.eventCategory}</Badge>
                        <strong className="text-sm text-ink">{e.eventType}</strong>
                      </div>
                      <small className={kv}>{formatTimestamp(e.eventTimestamp)}</small>
                    </div>

                    {e.message && <div className="mt-1 text-sm text-ink">{e.message}</div>}

                    {/* Structured chips */}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {e.orderId && (
                        <small className={kv}>
                          Order: <code className="text-xs text-ink">{e.orderId}</code>
                          {e.orderStatus && <Badge tone="neutral" className="ml-1">{e.orderStatus}</Badge>}
                          {e.orderType && <Badge tone="neutral" className="ml-1">{e.orderType}</Badge>}
                        </small>
                      )}
                      {e.price !== undefined && e.price !== null && (
                        <small className={kv}>price: <strong className="text-ink">{e.price}</strong></small>
                      )}
                      {e.slPrice !== undefined && e.slPrice !== null && (
                        <small className={kv}>SL: <strong className="text-ink">{e.slPrice}</strong></small>
                      )}
                      {e.targetPrice !== undefined && e.targetPrice !== null && (
                        <small className={kv}>target: <strong className="text-ink">{e.targetPrice}</strong></small>
                      )}
                      {e.quantity !== undefined && e.quantity !== null && (
                        <small className={kv}>qty: <strong className="text-ink">{e.filledQuantity ?? 0}/{e.quantity}</strong></small>
                      )}
                    </div>

                    {e.errorMessage && <div className="mt-1 text-xs text-danger-500">Error: {e.errorMessage}</div>}
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
