/**
 * The Terminal: what each account holds, what it made, and the brake.
 *
 * The first page where the operator sees what the engine did rather than
 * reads the log. Every row is the engine's own book -- counts, P&L and
 * positions from the trades it holds and the last tick it saw. The broker's
 * view is a different thing and is fetched only when asked for, so the two
 * can be compared and never confused.
 *
 * Live over the one socket: all summaries on subscribe, then only the rows
 * that changed, and every alert the moment it is raised. Money arrives as
 * strings and is formatted here, never computed.
 *
 * Square-off is the operator's hand on the brake, and it goes through the
 * same service the day model uses at the close.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  BsArrowRepeat,
  BsBank,
  BsBell,
  BsExclamationTriangleFill,
  BsInfoCircleFill,
  BsStopCircle,
  BsTerminal,
} from 'react-icons/bs';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, Container, Nav, Spinner } from '@/components/ui/rbShim';
import { BottomSlidePanel, ConfirmModal, PageHeader } from '@/components/common';
import { useWebSocket } from '@/hooks/useWebSocket';
import { liveTerminalService } from '@/services/terminal/liveTerminalService';
import type {
  AccountSummary,
  EnginePosition,
  SquareOffScope,
  TerminalAlert,
  TerminalSocketMessage,
  TerminalTrade,
} from '@/types/terminal-live';

type Mode = 'live' | 'paper';

const rupees = (value: string | null | undefined, decimals = 0): string => {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: 2 });
};

const tone = (value: string | null | undefined): string => {
  const n = Number(value ?? 0);
  if (n > 0) return 'text-success-600 dark:text-success-400';
  if (n < 0) return 'text-danger';
  return 'text-ink';
};

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { hour12: false }) : '—';

const Money: React.FC<{ value: string | null | undefined; className?: string }> = ({
  value,
  className = '',
}) => (
  <span className={`font-mono tabular-nums ${tone(value)} ${className}`}>{rupees(value)}</span>
);

const TerminalPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('live');
  const [rows, setRows] = useState<Map<string, AccountSummary>>(new Map());
  const [alerts, setAlerts] = useState<TerminalAlert[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ id: string; scope: SquareOffScope; name: string } | null>(
    null,
  );

  // The first set over REST, so the page is not blank until the socket speaks.
  const initial = useQuery({
    queryKey: ['terminal', 'summaries'],
    queryFn: () => liveTerminalService.summaries(),
  });
  const initialAlerts = useQuery({
    queryKey: ['terminal', 'alerts'],
    queryFn: () => liveTerminalService.alerts(),
  });
  useEffect(() => {
    if (initial.data) setRows(new Map(initial.data.map((r) => [r.tradingClientId, r])));
  }, [initial.data]);
  useEffect(() => {
    if (initialAlerts.data) setAlerts(initialAlerts.data);
  }, [initialAlerts.data]);

  const onMessage = useCallback((data: unknown) => {
    const message = data as TerminalSocketMessage;
    if ((message.type === 'full' || message.type === 'delta') && message.terminalSummaries) {
      setRows((before) => {
        const next = message.type === 'full' ? new Map<string, AccountSummary>() : new Map(before);
        for (const row of message.terminalSummaries ?? []) next.set(row.tradingClientId, row);
        return next;
      });
    } else if (message.type === 'alert' && message.alert) {
      const raised = message.alert;
      setAlerts((before) => [raised, ...before].slice(0, 200));
      if (raised.alertLevel === 'CRITICAL') toast.error(`${raised.entityName}: ${raised.alertMessage}`);
      else if (raised.alertLevel === 'WARNING') toast.warn(`${raised.entityName}: ${raised.alertMessage}`);
    }
  }, []);

  const ws = useWebSocket({ subscriptions: ['terminal'], onMessage });
  useEffect(() => {
    ws.connect();
    // Deliberately not disconnecting on unmount: the socket is shared with
    // the rest of the Console.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const squareOff = useMutation({
    mutationFn: ({ id, scope }: { id: string; scope: SquareOffScope }) =>
      liveTerminalService.squareOff(id, scope),
    onSuccess: (outcome, { id }) => {
      toast.success(`${outcome.requested.length} exit(s) requested`);
      const skipped = Object.entries(outcome.skipped);
      if (skipped.length) toast.warn(skipped.map(([t, why]) => `${t}: ${why}`).join('; '));
      queryClient.invalidateQueries({ queryKey: ['terminal', 'details', id] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setAsking(null),
  });

  const list = useMemo(() => [...rows.values()], [rows]);
  const pick = (row: AccountSummary) => (mode === 'paper' ? row.paperPnl : row.pnl);
  const counts = (row: AccountSummary) => (mode === 'paper' ? row.paperCounts : row.counts);
  const totals = useMemo(() => {
    let realised = 0;
    let unrealised = 0;
    let unpriced = 0;
    for (const row of list) {
      const p = pick(row);
      realised += Number(p.realised);
      unrealised += Number(p.unrealised);
      unpriced += p.unpriced;
    }
    return { realised, unrealised, total: realised + unrealised, unpriced };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, mode]);

  const opened = open ? rows.get(open) ?? null : null;

  return (
    <Container fluid className="py-4">
      <PageHeader
        title="Terminal"
        subtitle="Each account as the engine believes it stands"
        icon={<BsTerminal size={24} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Badge bg={ws.isConnected ? 'success' : ws.isConnecting ? 'warning' : 'danger'}>
          {ws.isConnected ? 'Live' : ws.isConnecting ? 'Connecting' : 'Disconnected'}
        </Badge>
        {!ws.isConnected && (
          <Button variant="outline-secondary" size="sm" onClick={() => ws.reconnect()}>
            <BsArrowRepeat className="me-1" />
            Reconnect
          </Button>
        )}
        <Nav variant="pills" activeKey={mode} onSelect={(k) => setMode((k as Mode) || 'live')}>
          <Nav.Item>
            <Nav.Link eventKey="live">Live</Nav.Link>
          </Nav.Item>
          <Nav.Item>
            <Nav.Link eventKey="paper">Paper</Nav.Link>
          </Nav.Item>
        </Nav>
        <div className="ms-auto flex gap-4 text-sm">
          <div>
            <div className="text-ink-faint text-xs uppercase">Realised</div>
            <Money value={String(totals.realised)} className="text-lg" />
          </div>
          <div>
            <div className="text-ink-faint text-xs uppercase">Unrealised</div>
            <Money value={String(totals.unrealised)} className="text-lg" />
            {totals.unpriced > 0 && (
              <div className="text-warning-600 text-xs">{totals.unpriced} unpriced</div>
            )}
          </div>
          <div>
            <div className="text-ink-faint text-xs uppercase">Total</div>
            <Money value={String(totals.total)} className="text-lg font-semibold" />
          </div>
        </div>
      </div>

      {initial.error && (
        <Alert variant="danger">{(initial.error as Error).message}</Alert>
      )}

      <Card className="mb-4">
        <Card.Header className="flex items-center gap-2">
          <BsBank />
          <h5 className="mb-0">Accounts</h5>
          <Badge bg="secondary" pill>
            {list.length}
          </Badge>
        </Card.Header>
        <Card.Body>
          {initial.isLoading && <Spinner />}
          {!initial.isLoading && list.length === 0 && (
            <Alert variant="info" className="mb-0">
              No trading client yet. Add one on the Trading Clients page and log it in.
            </Alert>
          )}
          {list.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-ink-faint text-xs uppercase">
                  <tr>
                    <th className="py-1 text-left">Account</th>
                    <th className="py-1 text-left">Status</th>
                    <th className="py-1 text-right">Open</th>
                    <th className="py-1 text-right">Active</th>
                    <th className="py-1 text-right">Done</th>
                    <th className="py-1 text-right">Positions</th>
                    <th className="py-1 text-right">Realised</th>
                    <th className="py-1 text-right">Unrealised</th>
                    <th className="py-1 text-right">Total</th>
                    <th className="py-1 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((row) => {
                    const p = pick(row);
                    const c = counts(row);
                    return (
                      <tr key={row.tradingClientId} className="border-t border-hairline align-top">
                        <td className="py-2 pr-3">
                          <button
                            type="button"
                            className="font-semibold hover:underline"
                            onClick={() => setOpen(row.tradingClientId)}
                          >
                            {row.displayName}
                          </button>
                          <div className="text-ink-faint font-mono text-xs uppercase">
                            {row.broker}:{row.clientId}
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          {row.isTrading ? (
                            <Badge bg="success">Trading</Badge>
                          ) : (
                            <>
                              <Badge bg="secondary">Not trading</Badge>
                              <div className="text-ink-faint text-xs">{row.unavailableBecause}</div>
                            </>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono">{c.open}</td>
                        <td className="py-2 pr-3 text-right font-mono">{c.active}</td>
                        <td className="py-2 pr-3 text-right font-mono">
                          {c.completed}
                          {c.cancelled + c.failed > 0 && (
                            <span className="text-ink-faint"> / {c.cancelled + c.failed}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono">
                          {mode === 'paper' ? row.paperPositions : row.positions}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          <Money value={p.realised} />
                        </td>
                        <td className="py-2 pr-3 text-right">
                          <Money value={p.unrealised} />
                          {p.unpriced > 0 && (
                            <div className="text-warning-600 text-xs">{p.unpriced} unpriced</div>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          <Money value={p.total} className="font-semibold" />
                        </td>
                        <td className="py-2 text-right">
                          {row.isTrading && (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="outline-danger"
                                size="sm"
                                disabled={squareOff.isPending}
                                onClick={() =>
                                  setAsking({
                                    id: row.tradingClientId,
                                    scope: 'INTRADAY',
                                    name: row.displayName,
                                  })
                                }
                              >
                                Exit intraday
                              </Button>
                              <Button
                                variant="danger"
                                size="sm"
                                disabled={squareOff.isPending}
                                onClick={() =>
                                  setAsking({
                                    id: row.tradingClientId,
                                    scope: 'ALL',
                                    name: row.displayName,
                                  })
                                }
                              >
                                <BsStopCircle className="me-1" />
                                Exit all
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card.Body>
      </Card>

      <Card>
        <Card.Header className="flex items-center gap-2">
          <BsBell />
          <h5 className="mb-0">Alerts today</h5>
          <Badge bg="secondary" pill>
            {alerts.length}
          </Badge>
        </Card.Header>
        <Card.Body>
          {alerts.length === 0 && <div className="text-ink-faint text-sm">Nothing raised today.</div>}
          {alerts.length > 0 && (
            <ul className="m-0 list-none p-0 text-sm">
              {alerts.slice(0, 50).map((a, i) => (
                <li key={`${a.timestamp}-${i}`} className="flex items-start gap-2 border-t border-hairline py-1">
                  {a.alertLevel === 'CRITICAL' ? (
                    <BsExclamationTriangleFill className="text-danger mt-1 shrink-0" />
                  ) : a.alertLevel === 'WARNING' ? (
                    <BsExclamationTriangleFill className="text-warning-500 mt-1 shrink-0" />
                  ) : (
                    <BsInfoCircleFill className="text-accent-500 mt-1 shrink-0" />
                  )}
                  <span className="text-ink-faint font-mono text-xs">{clock(a.timestamp)}</span>
                  <span className="font-semibold">{a.entityName}</span>
                  <span className="text-ink-soft">{a.operation}</span>
                  <span>{a.alertMessage}</span>
                  {a.occurrences > 1 && <Badge bg="secondary">×{a.occurrences}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card.Body>
      </Card>

      <ConfirmModal
        show={asking !== null}
        onHide={() => setAsking(null)}
        onConfirm={() => asking && squareOff.mutate({ id: asking.id, scope: asking.scope })}
        title={asking ? `Exit ${asking.scope === 'ALL' ? 'everything' : 'intraday'} on ${asking.name}` : ''}
        message={
          asking?.scope === 'ALL'
            ? 'Request an exit for every live trade on this account? Each goes through the square-off service, is retried if the broker refuses, and raises an alert if it cannot be placed.'
            : 'Request an exit for every intraday (MIS) trade on this account?'
        }
        confirmLabel="Exit"
        confirmVariant="danger"
        loading={squareOff.isPending}
      />

      <AccountPanel
        row={opened}
        mode={mode}
        onClose={() => setOpen(null)}
        onSquareOffTrade={(id, tradeId) =>
          liveTerminalService
            .squareOffTrade(id, tradeId)
            .then(() => {
              toast.success(`exit requested for ${tradeId}`);
              queryClient.invalidateQueries({ queryKey: ['terminal', 'details', id] });
            })
            .catch((e: Error) => toast.error(e.message))
        }
      />
    </Container>
  );
};

type Tab = 'positions' | 'active' | 'open' | 'completed' | 'cancelled' | 'broker' | 'margins';

const AccountPanel: React.FC<{
  row: AccountSummary | null;
  mode: Mode;
  onClose: () => void;
  onSquareOffTrade: (id: string, tradeId: string) => void;
}> = ({ row, mode, onClose, onSquareOffTrade }) => {
  const [tab, setTab] = useState<Tab>('positions');
  const id = row?.tradingClientId ?? null;

  const details = useQuery({
    queryKey: ['terminal', 'details', id],
    queryFn: () => liveTerminalService.details(id!),
    enabled: id !== null,
    refetchInterval: 5000,
  });
  const broker = useQuery({
    queryKey: ['terminal', 'broker-positions', id],
    queryFn: () => liveTerminalService.brokerPositions(id!),
    enabled: id !== null && tab === 'broker',
    retry: false,
  });
  const margins = useQuery({
    queryKey: ['terminal', 'margins', id],
    queryFn: () => liveTerminalService.margins(id!),
    enabled: id !== null && tab === 'margins',
    retry: false,
  });

  const paper = mode === 'paper';
  const groups = details.data?.trades ?? null;
  const trades = (list: TerminalTrade[] | undefined) =>
    (list ?? []).filter((t) => t.isPaper === paper);
  const positions = (details.data?.positions ?? []).filter((p) => p.isPaper === paper);

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: 'positions', label: 'Positions', count: positions.length },
    { key: 'active', label: 'Active', count: trades(groups?.active).length },
    { key: 'open', label: 'Open', count: trades(groups?.open).length },
    { key: 'completed', label: 'Completed', count: trades(groups?.completed).length },
    {
      key: 'cancelled',
      label: 'Cancelled / failed',
      count: trades(groups?.cancelled).length + trades(groups?.failed).length,
    },
    { key: 'broker', label: 'Broker positions' },
    { key: 'margins', label: 'Margins' },
  ];

  return (
    <BottomSlidePanel
      isOpen={row !== null}
      onClose={onClose}
      title={row ? row.displayName : ''}
      subtitle={row ? `${row.broker.toUpperCase()}:${row.clientId} · ${paper ? 'paper' : 'live'}` : undefined}
      height="70vh"
    >
      {row && !row.isTrading && (
        <Alert variant="warning">{row.unavailableBecause}</Alert>
      )}
      {row?.isTrading && (
        <>
          <Nav variant="tabs" activeKey={tab} onSelect={(k) => setTab((k as Tab) || 'positions')} className="mb-3">
            {TABS.map((t) => (
              <Nav.Item key={t.key}>
                <Nav.Link eventKey={t.key}>
                  {t.label}
                  {t.count !== undefined && (
                    <Badge bg="secondary" pill className="ms-1">
                      {t.count}
                    </Badge>
                  )}
                </Nav.Link>
              </Nav.Item>
            ))}
          </Nav>
          {details.isLoading && <Spinner />}
          {tab === 'positions' && <PositionsTable rows={positions} />}
          {tab === 'active' && (
            <TradesTable rows={trades(groups?.active)} onExit={(t) => onSquareOffTrade(row.tradingClientId, t)} />
          )}
          {tab === 'open' && (
            <TradesTable rows={trades(groups?.open)} onExit={(t) => onSquareOffTrade(row.tradingClientId, t)} />
          )}
          {tab === 'completed' && <TradesTable rows={trades(groups?.completed)} />}
          {tab === 'cancelled' && (
            <TradesTable rows={[...trades(groups?.cancelled), ...trades(groups?.failed)]} />
          )}
          {tab === 'broker' && (
            <>
              {broker.isFetching && <Spinner />}
              {broker.error && <Alert variant="danger">{(broker.error as Error).message}</Alert>}
              {broker.data && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-ink-faint text-xs uppercase">
                      <tr>
                        <th className="py-1 text-left">Instrument</th>
                        <th className="py-1 text-left">Product</th>
                        <th className="py-1 text-right">Qty</th>
                        <th className="py-1 text-right">Avg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {broker.data.length === 0 && (
                        <tr>
                          <td colSpan={4} className="text-ink-faint py-2">
                            The broker reports no positions.
                          </td>
                        </tr>
                      )}
                      {broker.data.map((p) => (
                        <tr key={`${p.instrument}-${p.product}`} className="border-t border-hairline">
                          <td className="py-1 pr-3 font-mono">{p.tradingSymbol}</td>
                          <td className="py-1 pr-3">{p.product}</td>
                          <td className="py-1 pr-3 text-right font-mono">{p.quantity}</td>
                          <td className="py-1 pr-3 text-right font-mono">{rupees(p.averagePrice, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <small className="text-ink-faint">
                    Fetched from the broker just now. The engine’s own view is on the Positions tab;
                    where they differ, the broker is the truth and the engine halts that instrument.
                  </small>
                </div>
              )}
            </>
          )}
          {tab === 'margins' && (
            <>
              {margins.isFetching && <Spinner />}
              {margins.error && <Alert variant="danger">{(margins.error as Error).message}</Alert>}
              {margins.data && (
                <dl className="grid grid-cols-3 gap-4 text-sm">
                  <dt className="text-ink-faint">Available</dt>
                  <dt className="text-ink-faint">Used</dt>
                  <dt className="text-ink-faint">Total</dt>
                  <dd className="font-mono">{rupees(margins.data.available)}</dd>
                  <dd className="font-mono">{rupees(margins.data.used)}</dd>
                  <dd className="font-mono">{rupees(margins.data.total)}</dd>
                </dl>
              )}
            </>
          )}
        </>
      )}
    </BottomSlidePanel>
  );
};

const PositionsTable: React.FC<{ rows: EnginePosition[] }> = ({ rows }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead className="text-ink-faint text-xs uppercase">
        <tr>
          <th className="py-1 text-left">Instrument</th>
          <th className="py-1 text-left">Product</th>
          <th className="py-1 text-right">Buy</th>
          <th className="py-1 text-right">Sell</th>
          <th className="py-1 text-right">Net</th>
          <th className="py-1 text-right">Buy avg</th>
          <th className="py-1 text-right">Sell avg</th>
          <th className="py-1 text-right">LTP</th>
          <th className="py-1 text-right">Realised</th>
          <th className="py-1 text-right">Unrealised</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={10} className="text-ink-faint py-2">
              No position.
            </td>
          </tr>
        )}
        {rows.map((p) => (
          <tr key={`${p.instrument}-${p.product}-${p.isPaper}`} className="border-t border-hairline">
            <td className="py-1 pr-3 font-mono">{p.tradingSymbol}</td>
            <td className="py-1 pr-3">{p.product}</td>
            <td className="py-1 pr-3 text-right font-mono">{p.buyQuantity}</td>
            <td className="py-1 pr-3 text-right font-mono">{p.sellQuantity}</td>
            <td className={`py-1 pr-3 text-right font-mono ${p.netQuantity === 0 ? 'text-ink-faint' : ''}`}>
              {p.netQuantity}
            </td>
            <td className="py-1 pr-3 text-right font-mono">{rupees(p.buyAverage, 2)}</td>
            <td className="py-1 pr-3 text-right font-mono">{rupees(p.sellAverage, 2)}</td>
            <td className="py-1 pr-3 text-right font-mono">{rupees(p.lastPrice, 2)}</td>
            <td className="py-1 pr-3 text-right">
              <Money value={p.realised} />
            </td>
            <td className="py-1 pr-3 text-right">
              {p.unrealised === null ? (
                <span className="text-warning-600 text-xs">unpriced</span>
              ) : (
                <Money value={p.unrealised} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const TradesTable: React.FC<{ rows: TerminalTrade[]; onExit?: (tradeId: string) => void }> = ({
  rows,
  onExit,
}) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead className="text-ink-faint text-xs uppercase">
        <tr>
          <th className="py-1 text-left">Trade</th>
          <th className="py-1 text-left">Instrument</th>
          <th className="py-1 text-left">Strategy</th>
          <th className="py-1 text-left">Side</th>
          <th className="py-1 text-right">Qty</th>
          <th className="py-1 text-right">Entry</th>
          <th className="py-1 text-right">Stop</th>
          <th className="py-1 text-right">Target</th>
          <th className="py-1 text-right">Exit</th>
          <th className="py-1 text-right">P&L</th>
          <th className="py-1 text-left">Reason</th>
          {onExit && <th className="py-1 text-right" />}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={12} className="text-ink-faint py-2">
              Nothing here.
            </td>
          </tr>
        )}
        {rows.map((t) => (
          <tr key={t.tradeId} className="border-t border-hairline">
            <td className="py-1 pr-3 font-mono text-xs">
              <Link
                to={`/console/trade-log/${encodeURIComponent(t.tradeId)}`}
                className="text-primary-500"
                title="What the engine did with this trade, in order"
              >
                {t.tradeId}
              </Link>
              {t.isHedge && <Badge bg="secondary" className="ms-1">hedge</Badge>}
            </td>
            <td className="py-1 pr-3 font-mono">{t.tradingSymbol}</td>
            <td className="py-1 pr-3">
              {t.strategy}
              {t.group !== 'DEFAULT' && <span className="text-ink-faint"> · {t.group}</span>}
            </td>
            <td className="py-1 pr-3">
              <Badge bg={t.direction === 'LONG' ? 'success' : 'danger'}>{t.direction}</Badge>{' '}
              <span className="text-ink-faint text-xs">{t.product}</span>
            </td>
            <td className="py-1 pr-3 text-right font-mono">
              {t.filledQuantity}/{t.quantity}
            </td>
            <td className="py-1 pr-3 text-right font-mono">{rupees(t.entry, 2)}</td>
            <td className="py-1 pr-3 text-right font-mono">{rupees(t.stopLoss, 2)}</td>
            <td className="py-1 pr-3 text-right font-mono">{rupees(t.target, 2)}</td>
            <td className="py-1 pr-3 text-right font-mono">{rupees(t.exit, 2)}</td>
            <td className="py-1 pr-3 text-right">
              <Money value={t.realisedPnl} />
            </td>
            <td className="py-1 pr-3 text-xs">
              {t.exitingFor && <span className="text-warning-600">exiting: {t.exitingFor}</span>}
              {t.exitReason && <span>{t.exitReason}</span>}
              {t.failureReason && <span className="text-danger">{t.failureReason}</span>}
            </td>
            {onExit && (
              <td className="py-1 text-right">
                <Button variant="outline-danger" size="sm" onClick={() => onExit(t.tradeId)}>
                  Exit
                </Button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default TerminalPage;
