/**
 * Segment hours: what each segment of a venue trades by.
 *
 * A segment left unset trades the venue's hours; one set says only what
 * differs -- NSE's cash segment closes at 15:30 while NFO trades to 15:40.
 * The engine reads these at its next start, like the venue's own hours.
 */

import { useState } from 'react';
import { BsClockHistory } from 'react-icons/bs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { Badge, Button, Spinner } from '@/components/ui';
import { exchangeService } from '@/services/admin/exchangeService';
import type { Exchange, ExchangeSegmentHours } from '@/types/exchange';

const card = 'rounded-card border border-hairline bg-card';
const cell = 'px-3 py-1.5';
const head = 'px-3 py-1.5 text-left';
const ctrl = 'h-8 rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60 disabled:opacity-60';

const hhmm = (value: string | null) => (value ? value.slice(0, 5) : '');

const Row: React.FC<{ exchange: Exchange; hours: ExchangeSegmentHours; readOnly: boolean }> = ({ exchange, hours, readOnly }) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(hhmm(hours.ownMarketOpen));
  const [close, setClose] = useState(hhmm(hours.ownMarketClose));
  const dirty = open !== hhmm(hours.ownMarketOpen) || close !== hhmm(hours.ownMarketClose);

  const done = (message: string) => {
    queryClient.invalidateQueries({ queryKey: ['exchange-segments', exchange.exchange] });
    toast.success(message);
  };
  const save = useMutation({
    mutationFn: () => exchangeService.setSegmentHours(exchange.exchange, hours.segment, { marketOpen: open || null, marketClose: close || null }),
    onSuccess: () => done(`${exchange.exchange} ${hours.code} hours saved; the engine reads them at its next start`),
    onError: (e: Error) => toast.error(e.message || 'Could not save the hours'),
  });
  const clear = useMutation({
    mutationFn: () => exchangeService.clearSegmentHours(exchange.exchange, hours.segment),
    onSuccess: () => {
      setOpen('');
      setClose('');
      done(`${exchange.exchange} ${hours.code} trades the venue's hours again`);
    },
    onError: (e: Error) => toast.error(e.message || 'Could not clear the hours'),
  });
  const busy = save.isPending || clear.isPending;

  return (
    <tr className="hover:bg-raised/50">
      <td className={`${cell} font-medium text-ink`}>
        {hours.code} <span className="text-xs text-ink-faint">· {hours.segment}</span>
      </td>
      <td className={`${cell} font-mono text-sm text-ink`}>
        {hhmm(hours.marketOpen)}–{hhmm(hours.marketClose)}
      </td>
      <td className={cell}>
        {hours.inherited ? <Badge tone="neutral">Venue's hours</Badge> : <Badge tone="primary">Own hours</Badge>}
      </td>
      <td className={cell}>
        <input type="time" className={ctrl} value={open} onChange={(e) => setOpen(e.target.value)} disabled={readOnly || busy} placeholder={hhmm(exchange.marketOpen ?? null)} title={`Blank inherits ${hhmm(exchange.marketOpen ?? null)}`} />
      </td>
      <td className={cell}>
        <input type="time" className={ctrl} value={close} onChange={(e) => setClose(e.target.value)} disabled={readOnly || busy} title={`Blank inherits ${hhmm(exchange.marketClose ?? null)}`} />
      </td>
      {!readOnly && (
        <td className={`${cell} whitespace-nowrap`}>
          <Button variant="primary" size="sm" onClick={() => save.mutate()} disabled={!dirty || busy}>
            {save.isPending ? <Spinner size="sm" /> : 'Save'}
          </Button>
          {!hours.inherited && (
            <Button variant="ghost" size="sm" className="ml-1" onClick={() => clear.mutate()} disabled={busy} title="Back to the venue's hours">
              Inherit
            </Button>
          )}
        </td>
      )}
    </tr>
  );
};

const VenueSegments: React.FC<{ exchange: Exchange; readOnly: boolean }> = ({ exchange, readOnly }) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['exchange-segments', exchange.exchange],
    queryFn: () => exchangeService.getSegments(exchange.exchange),
  });
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 text-sm font-semibold text-ink">
        {exchange.exchange} <span className="text-xs font-normal text-ink-soft">· venue hours {hhmm(exchange.marketOpen ?? null)}–{hhmm(exchange.marketClose ?? null)}</span>
      </div>
      {error ? (
        <div className="text-sm text-danger-500">{(error as Error).message}</div>
      ) : isLoading ? (
        <div className="text-sm text-ink-soft"><Spinner size="sm" /> Loading…</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-raised text-xs uppercase text-ink-faint">
            <tr>
              <th className={head}>Segment</th>
              <th className={head}>Trades</th>
              <th className={head}>Source</th>
              <th className={head}>Own open</th>
              <th className={head}>Own close</th>
              {!readOnly && <th className={head}></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {(data ?? []).map((hours) => (
              <Row key={`${exchange.exchange}:${hours.segment}:${hours.ownMarketOpen}:${hours.ownMarketClose}`} exchange={exchange} hours={hours} readOnly={readOnly} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const SegmentHours: React.FC<{ exchanges: Exchange[]; readOnly?: boolean }> = ({ exchanges, readOnly = false }) => (
  <div className={`${card} mt-4`}>
    <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
      <BsClockHistory className="text-primary-500" />
      <h5 className="mb-0 text-sm font-semibold text-ink">Segment hours</h5>
      <span className="text-xs text-ink-soft">A segment left blank trades the venue's hours. Set only what differs, such as the cash close at 15:30.</span>
    </div>
    <div className="p-4">
      {exchanges.map((exchange) => (
        <VenueSegments key={exchange.exchange} exchange={exchange} readOnly={readOnly} />
      ))}
    </div>
  </div>
);

export default SegmentHours;
