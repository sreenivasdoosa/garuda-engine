/**
 * The ticker, under the operator's hand.
 *
 * What the feed is doing, and three buttons: start, stop, restart. The day
 * model does all of this by itself -- the feed comes up at the first venue's
 * open, goes down after the last one's close, and is replaced on a login --
 * so these exist for the morning it did not, and for the holiday session the
 * day model would never start. Each action asks first, as the reference does:
 * a stopped feed is a Console with no prices and an engine with no entries.
 *
 * Polled every five seconds while the page is open, because the state moves
 * on its own -- the monitor reconnects a dropped socket without being asked.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Alert, Badge, Button, Card, Spinner } from '@/components/ui/rbShim';
import { BsArrowRepeat, BsPlayFill, BsStopFill } from 'react-icons/bs';
import { ConfirmModal } from '@/components/common';
import { dataProvidersService } from '@/services/admin/dataProviderService';
import type { TickerStatus } from '@/types/data-provider';

type Action = 'start' | 'stop' | 'restart';

const ASK: Record<Action, { title: string; message: string; label: string }> = {
  start: {
    title: 'Start the feed',
    message: 'Start the live feed now? It begins receiving ticks from the active provider.',
    label: 'Start',
  },
  stop: {
    title: 'Stop the feed',
    message:
      'Stop the live feed? Every price stops moving until it is started again, and no strategy can enter. It starts again by itself at the next venue’s open.',
    label: 'Stop',
  },
  restart: {
    title: 'Restart the feed',
    message: 'Replace the connection? Prices pause for a moment while the new socket comes up.',
    label: 'Restart',
  },
};

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { hour12: false }) : '—';

function statusBadge(status: TickerStatus) {
  if (!status.nominated) return <Badge bg="secondary">No provider</Badge>;
  switch (status.status) {
    case 'connected':
      return <Badge bg="success">Connected</Badge>;
    case 'disconnected':
      return <Badge bg="danger">Disconnected</Badge>;
    default:
      return <Badge bg="secondary">Stopped</Badge>;
  }
}

export const TickerCard: React.FC = () => {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<Action | null>(null);

  const { data: status, isLoading, error } = useQuery({
    queryKey: ['market-data', 'ticker'],
    queryFn: () => dataProvidersService.ticker(),
    refetchInterval: 5000,
    retry: false,
  });

  const act = useMutation({
    mutationFn: (action: Action) => {
      if (action === 'start') return dataProvidersService.startTicker();
      if (action === 'stop') return dataProvidersService.stopTicker();
      return dataProvidersService.restartTicker();
    },
    onSuccess: (next, action) => {
      queryClient.setQueryData(['market-data', 'ticker'], next);
      if (next.status === 'connected') toast.success(`Feed ${action}ed`);
      else if (action === 'stop') toast.success('Feed stopped');
      else toast.warn(`Feed ${action}ed, but it is not connected yet. The monitor keeps trying.`);
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setAsking(null),
  });

  return (
    <Card className="mb-4">
      <Card.Header className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <h5 className="mb-0">Ticker</h5>
          {status && statusBadge(status)}
        </span>
        {status?.nominated && (
          <div className="flex gap-2">
            <Button
              variant="outline-primary"
              size="sm"
              disabled={status.isRunning || act.isPending}
              onClick={() => setAsking('start')}
            >
              <BsPlayFill className="me-1" />
              Start
            </Button>
            <Button
              variant="outline-danger"
              size="sm"
              disabled={!status.isRunning || act.isPending}
              onClick={() => setAsking('stop')}
            >
              <BsStopFill className="me-1" />
              Stop
            </Button>
            <Button
              variant="outline-secondary"
              size="sm"
              disabled={act.isPending}
              onClick={() => setAsking('restart')}
            >
              <BsArrowRepeat className="me-1" />
              Restart
            </Button>
          </div>
        )}
      </Card.Header>
      <Card.Body>
        {isLoading && <Spinner />}
        {error && (
          <Alert variant="warning" className="mb-0">
            {(error as Error).message}
          </Alert>
        )}
        {status && !status.nominated && (
          <Alert variant="info" className="mb-0">
            Nothing is nominated for ticks, so there is no feed to control. Choose a provider under
            Active and log it in.
          </Alert>
        )}
        {status?.nominated && (
          <>
            <dl className="mb-0 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
              <dt className="text-ink-faint">Provider</dt>
              <dd className="uppercase">{status.provider ?? '—'}</dd>
              <dt className="text-ink-faint">Connected since</dt>
              <dd className="font-mono">{clock(status.connectedSince)}</dd>
              <dt className="text-ink-faint">Last tick</dt>
              <dd className="font-mono">{clock(status.lastTickAt)}</dd>
              <dt className="text-ink-faint">Quoting</dt>
              <dd className="font-mono">
                {status.quoting} of {status.subscriptions}
              </dd>
              <dt className="text-ink-faint">Ticks published</dt>
              <dd className="font-mono">{status.ticksPublished.toLocaleString('en-IN')}</dd>
              <dt className="text-ink-faint">Reconnects</dt>
              <dd className="font-mono">{status.reconnects}</dd>
            </dl>
            {status.status === 'disconnected' && (
              <Alert variant="warning" className="mt-3 mb-0 py-2 text-sm">
                The socket is down
                {status.lastDisconnectReason ? ` (${status.lastDisconnectReason})` : ''}. The
                monitor reconnects on its own
                {status.consecutiveFailures > 0
                  ? `; ${status.consecutiveFailures} attempt(s) have failed so far.`
                  : '.'}
              </Alert>
            )}
            {status.status === 'stopped' && (
              <Alert variant="info" className="mt-3 mb-0 py-2 text-sm">
                The feed is stopped. It starts by itself at the first venue’s open; press Start to
                bring it up now, holiday or not.
              </Alert>
            )}
          </>
        )}
      </Card.Body>

      <ConfirmModal
        show={asking !== null}
        onHide={() => setAsking(null)}
        onConfirm={() => asking && act.mutate(asking)}
        title={asking ? ASK[asking].title : ''}
        message={asking ? ASK[asking].message : ''}
        confirmLabel={asking ? ASK[asking].label : 'Confirm'}
        confirmVariant={asking === 'stop' ? 'danger' : 'primary'}
        loading={act.isPending}
      />
    </Card>
  );
};

export default TickerCard;
