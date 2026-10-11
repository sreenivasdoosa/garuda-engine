/**
 * System Status: the engine, end to end, in one glance.
 *
 * Read from /api/system-status every fifteen seconds. The engine's panels
 * come from its own parts -- the feed, the loops, the venues, the risk
 * books -- and are absent on an API served without one, which the page says
 * rather than hides. The tables' panels -- strategies, accounts, brokers --
 * are always there. The probe is the one thing that costs a network
 * round-trip, so it runs on the button and nowhere else.
 */

import { useMemo, useState } from 'react';
import {
  BsActivity,
  BsArchive,
  BsArrowClockwise,
  BsBank,
  BsBroadcast,
  BsCardChecklist,
  BsCpu,
  BsDiagram3,
  BsGlobe,
  BsPeople,
  BsPlayCircle,
  BsShieldCheck,
} from 'react-icons/bs';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { PageHeader } from '@/components/common';
import { Badge, Button, Spinner, StatCard } from '@/components/ui';
import type { Tone } from '@/components/ui';
import { systemStatusService } from '@/services/system-status/systemStatusService';
import type {
  AccountRow,
  FeedState,
  HealthCheck,
  SessionState,
  SystemStatus as Snapshot,
  TimelineEvent,
} from '@/types/systemStatus';
import { DAY_PHASES, panel, panelError } from '@/types/systemStatus';

const REFRESH_MS = 15000;

// ---- how things read ------------------------------------------------------

const fmtNum = (n?: number | null) => (n === null || n === undefined ? '—' : n.toLocaleString());
const fmtWhen = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const fmtClock = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const fmtUptime = (s?: number | null) => {
  if (s === null || s === undefined) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const fmtAge = (iso?: string | null) => {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
};

const yesNo = (v: boolean | null | undefined, yes = 'Yes', no = 'No', noTone: Tone = 'neutral') =>
  v === null || v === undefined ? <Badge tone="neutral">n/a</Badge> : <Badge tone={v ? 'success' : noTone}>{v ? yes : no}</Badge>;

const feedTone: Record<FeedState, Tone> = { UP: 'success', DOWN: 'danger', INACTIVE: 'neutral' };
const feedWords: Record<FeedState, string> = { UP: 'Up', DOWN: 'Down', INACTIVE: 'Inactive' };

const sessionTone: Record<SessionState, Tone> = {
  LOGGED_IN: 'success',
  FAILED: 'danger',
  LOGGED_OUT: 'neutral',
  NONE: 'neutral',
};
const sessionWords: Record<SessionState, string> = {
  LOGGED_IN: 'Logged in',
  FAILED: 'Failed',
  LOGGED_OUT: 'Logged out',
  NONE: 'Never logged in',
};

// ---- small pieces -----------------------------------------------------------

const kv = 'text-xs text-ink-soft';
const cell = 'px-3 py-1.5';
const head = 'px-3 py-1.5 text-left';

const Metric: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode }> = ({ label, value, sub }) => (
  <div className="min-w-0">
    <div className={kv}>{label}</div>
    <div className="text-sm font-medium text-ink">{value}</div>
    {sub && <div className="text-xs text-ink-faint">{sub}</div>}
  </div>
);

const Panel: React.FC<{
  icon: React.ReactNode;
  title: string;
  right?: React.ReactNode;
  error?: string | null;
  flush?: boolean;
  children: React.ReactNode;
}> = ({ icon, title, right, error, flush = false, children }) => (
  <div className="rounded-card border border-hairline bg-card">
    <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
      <h5 className="mb-0 flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="text-primary-500">{icon}</span>
        {title}
      </h5>
      {right}
    </div>
    {error ? (
      <div className="px-4 py-3 text-sm text-danger-500">This panel could not be built: {error}</div>
    ) : (
      <div className={flush ? '' : 'p-4'}>{children}</div>
    )}
  </div>
);

const Absent: React.FC = () => (
  <div className="px-4 py-3 text-sm text-ink-soft">The API is running without an engine, so there is nothing to show here.</div>
);

const Timeline: React.FC<{ icon: React.ReactNode; title: string; events: TimelineEvent[] | undefined; empty: string }> = ({
  icon,
  title,
  events,
  empty,
}) => (
  <Panel icon={icon} title={title} right={<Badge tone="neutral">{events?.length ?? 0}</Badge>} flush>
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-raised text-xs uppercase text-ink-faint">
          <tr>
            <th className={head} style={{ width: '11rem' }}>When</th>
            <th className={head}>What</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {events && events.length > 0 ? (
            events.map((e, i) => (
              <tr key={i}>
                <td className={`${cell} whitespace-nowrap text-xs text-ink-soft`}>{fmtWhen(e.timestamp)}</td>
                <td className={`${cell} text-xs text-ink`}>{e.message}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2} className="py-4 text-center text-xs text-ink-soft">{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </Panel>
);

// ---- a phase, now -------------------------------------------------------------

const RunPhase: React.FC<{ venues: { code: string; tradingDay: string }[]; onRan: () => void }> = ({ venues, onRan }) => {
  const [exchange, setExchange] = useState(venues[0]?.code ?? '');
  const [phase, setPhase] = useState<string>('DAY_INIT');
  const [day, setDay] = useState('');
  const [confirming, setConfirming] = useState(false);
  const chosen = venues.find((v) => v.code === exchange) ?? venues[0];
  const effectiveDay = useMemo(() => day || chosen?.tradingDay || '', [day, chosen]);
  const run = useMutation({
    mutationFn: () => systemStatusService.runPhase({ exchange, phase, tradingDay: effectiveDay || undefined }),
    onSuccess: (result) => {
      setConfirming(false);
      if (result.ran) toast.success(`${result.exchange} ${result.phase} ran for ${effectiveDay}`);
      else toast.error(`${result.exchange} ${result.phase} failed: ${result.failure}`);
      onRan();
    },
    onError: (e: Error) => {
      setConfirming(false);
      toast.error(e.message || 'The phase could not be run');
    },
  });
  const dangerous = phase === 'INTRADAY_SQUARE_OFF' || phase === 'EOD' || phase === 'SESSION_CLOSE';
  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-hairline px-3 py-2">
      <div>
        <div className={kv}>Venue</div>
        <select className="h-7 rounded border border-hairline bg-card px-1 text-xs text-ink" value={exchange} onChange={(e) => { setExchange(e.target.value); setConfirming(false); }}>
          {venues.map((v) => (
            <option key={v.code} value={v.code}>{v.code}</option>
          ))}
        </select>
      </div>
      <div>
        <div className={kv}>Phase</div>
        <select className="h-7 rounded border border-hairline bg-card px-1 text-xs text-ink" value={phase} onChange={(e) => { setPhase(e.target.value); setConfirming(false); }}>
          {DAY_PHASES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      <div>
        <div className={kv}>Trading day</div>
        <input type="date" className="h-7 rounded border border-hairline bg-card px-1 text-xs text-ink" value={effectiveDay} onChange={(e) => { setDay(e.target.value); setConfirming(false); }} />
      </div>
      {confirming ? (
        <>
          <span className={`text-xs ${dangerous ? 'text-danger-500' : 'text-ink'}`}>
            Run {phase} for {exchange} on {effectiveDay} now{dangerous ? ' — it does what its name says' : ''}?
          </span>
          <Button variant={dangerous ? 'danger' : 'primary'} size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? <Spinner size="sm" /> : 'Yes, run it'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>No</Button>
        </>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)} disabled={!exchange}>
          <BsPlayCircle /> Run now
        </Button>
      )}
    </div>
  );
};

// ---- the page ---------------------------------------------------------------

const SystemStatus: React.FC = () => {
  const [probe, setProbe] = useState<HealthCheck | null>(null);

  const status = useQuery({
    queryKey: ['system-status'],
    queryFn: () => systemStatusService.getStatus(),
    refetchInterval: REFRESH_MS,
  });
  const timeline = useQuery({
    queryKey: ['system-status', 'init-timeline'],
    queryFn: () => systemStatusService.getInitTimeline(),
    refetchInterval: REFRESH_MS,
  });
  const probing = useMutation({
    mutationFn: () => systemStatusService.runHealthCheck(),
    onSuccess: (result) => {
      setProbe(result);
      if (result.tick.ok && result.history.ok) toast.success('Market data answered on both counts');
      else toast.warning('Market data did not answer on every count');
    },
    onError: (e: Error) => toast.error(e.message || 'The probe failed'),
  });

  const data: Snapshot | undefined = status.data;
  const runtime = panel(data?.runtime);
  const feed = panel(data?.feed);
  const loops = panel(data?.loops);
  const venues = panel(data?.venues);
  const files = panel(data?.instrumentFiles);
  const attached = data?.engineAttached ?? false;

  const refresh = () => {
    status.refetch();
    timeline.refetch();
  };

  const updated = status.dataUpdatedAt ? new Date(status.dataUpdatedAt).toLocaleTimeString() : '—';

  return (
    <div className="py-3">
      <PageHeader
        title="System Status"
        subtitle="The engine as it stands right now, end to end"
        icon={<BsActivity />}
        actions={
          <div className="flex items-center gap-3">
            <span className="text-xs text-ink-soft">
              Updated {updated}
              {status.isFetching && <Spinner size="sm" className="ml-2" />}
            </span>
            <Button variant="secondary" size="sm" onClick={refresh} disabled={status.isFetching}>
              <BsArrowClockwise className={status.isFetching ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        }
      />

      {status.error && (
        <div className="mb-3 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400">
          {(status.error as Error).message}
        </div>
      )}

      {status.isLoading ? (
        <div className="py-12 text-center text-ink-soft">
          <Spinner size="sm" /> Loading…
        </div>
      ) : data ? (
        <>
          {!attached && (
            <div className="mb-3 rounded border border-warning-500/30 bg-warning-500/10 px-3 py-2 text-sm text-warning-700 dark:text-warning-400">
              The API is running without an engine. The feed, the loops, the venues and the risk books cannot be read;
              what the tables say is below.
            </div>
          )}

          {/* The glance */}
          <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Market data"
              icon={<BsBroadcast />}
              tone={feed ? (feed.state === 'DOWN' ? 'danger' : feed.state === 'UP' ? 'success' : 'default') : 'default'}
              value={feed ? feedWords[feed.state] : '—'}
              hint={feed ? `${feed.provider ?? 'nothing nominated'} · quoting ${fmtNum(feed.quoting)} of ${fmtNum(feed.subscriptions)}` : 'no engine'}
            />
            <StatCard
              label="Engine"
              icon={<BsCpu />}
              tone={loops ? (loops.runnerRunning ? 'success' : 'warning') : 'default'}
              value={loops ? (loops.runnerRunning ? 'Running' : 'Stopped') : '—'}
              hint={
                loops
                  ? loops.tradeLoopsStarted
                    ? `${loops.accountsCycling.length} account(s) cycling · strategies ${loops.strategyLoop ? (loops.strategyLoop.running ? 'sweeping' : 'stopped') : 'none'}`
                    : 'the day has not started'
                  : 'no engine'
              }
            />
            <StatCard
              label="Accounts"
              icon={<BsPeople />}
              tone={data.accounts.failed > 0 ? 'warning' : 'default'}
              value={`${data.accounts.trading} / ${data.accounts.configured}`}
              hint={`trading of configured · ${data.accounts.loggedIn} logged in · ${data.accounts.failed} failed`}
            />
            <StatCard
              label="Risk"
              icon={<BsShieldCheck />}
              tone={data.risk.activeKillSwitches > 0 ? 'danger' : data.risk.breachesToday > 0 ? 'warning' : 'default'}
              value={`${data.risk.activeKillSwitches} switch${data.risk.activeKillSwitches === 1 ? '' : 'es'}`}
              hint={`${data.risk.breachesToday} breach${data.risk.breachesToday === 1 ? '' : 'es'} today · trading day ${data.tradingDay}`}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {/* Runtime */}
            <Panel
              icon={<BsActivity />}
              title="Runtime and resources"
              error={panelError(data.runtime)}
              right={runtime && <span className={kv}>v{runtime.version} · Python {runtime.python} · up {fmtUptime(runtime.uptimeSeconds)}</span>}
            >
              {runtime ? (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Metric label="Started" value={fmtWhen(runtime.startedAt)} />
                  <Metric label="Process memory" value={runtime.processRssMb === null ? '—' : `${fmtNum(runtime.processRssMb)} MB`} sub="resident set" />
                  <Metric
                    label="System memory"
                    value={runtime.systemMemoryTotalMb === null ? '—' : `${fmtNum(runtime.systemMemoryUsedMb)} / ${fmtNum(runtime.systemMemoryTotalMb)} MB`}
                    sub="used of total"
                  />
                  <Metric
                    label="Load"
                    value={runtime.loadAverage ? runtime.loadAverage.map((n) => n.toFixed(2)).join(' · ') : '—'}
                    sub={runtime.cpuCount ? `${runtime.cpuCount} cores` : undefined}
                  />
                  <Metric
                    label="Open files"
                    value={runtime.openFileDescriptors === null ? '—' : `${fmtNum(runtime.openFileDescriptors)} / ${fmtNum(runtime.maxFileDescriptors)}`}
                  />
                  <Metric label="Threads" value={fmtNum(runtime.threads)} />
                  <Metric label="Tasks" value={fmtNum(runtime.asyncioTasks)} sub="asyncio" />
                </div>
              ) : (
                <Absent />
              )}
            </Panel>

            {/* Feed */}
            <Panel
              icon={<BsBroadcast />}
              title="Market data feed"
              error={panelError(data.feed)}
              right={
                attached && (
                  <Button variant="secondary" size="sm" onClick={() => probing.mutate()} disabled={probing.isPending}>
                    {probing.isPending ? <Spinner size="sm" /> : <BsPlayCircle />} Probe quote and history
                  </Button>
                )
              }
            >
              {feed ? (
                <>
                  <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Metric label="State" value={<Badge tone={feedTone[feed.state]}>{feedWords[feed.state]}</Badge>} sub={feed.status} />
                    <Metric label="Provider" value={feed.provider ?? 'nothing nominated'} sub={feed.historyProvider ? `history: ${feed.historyProvider}` : 'no candle history'} />
                    <Metric label="Market open" value={yesNo(feed.marketOpen)} />
                    <Metric label="Quoting" value={`${fmtNum(feed.quoting)} / ${fmtNum(feed.subscriptions)}`} sub="of subscribed" />
                    <Metric label="Last tick" value={fmtClock(feed.lastTickAt)} sub={fmtAge(feed.lastTickAt) ?? 'none yet'} />
                    <Metric label="Connected since" value={fmtClock(feed.connectedSince)} />
                    <Metric label="Ticks published" value={fmtNum(feed.ticksPublished)} />
                    <Metric label="Reconnects" value={fmtNum(feed.reconnects)} sub={feed.consecutiveFailures ? `${feed.consecutiveFailures} failing in a row` : undefined} />
                  </div>
                  {feed.lastDisconnectReason && <div className="mb-2 text-xs text-ink-soft">Last disconnect: {feed.lastDisconnectReason}</div>}
                  {probe && (
                    <div className="mb-3 rounded border border-hairline bg-raised p-2">
                      <div className="mb-1 text-xs font-semibold text-ink">
                        Probe of <code>{probe.instrument}</code>
                      </div>
                      <table className="w-full text-sm">
                        <tbody>
                          {([
                            ['Tick', probe.tick, probe.tick.ok ? `${probe.tick.lastPrice} at ${fmtClock(probe.tick.at)}` : probe.tick.error],
                            ['History', probe.history, probe.history.ok ? `${probe.history.candles} candles (${probe.history.interval})` : probe.history.error],
                          ] as const).map(([name, result, detail]) => (
                            <tr key={name}>
                              <td className="py-0.5 pr-2 text-ink-soft">{name}</td>
                              <td className="py-0.5 pr-2">{yesNo(result.ok, 'OK', 'Failed', 'danger')}</td>
                              <td className="py-0.5 pr-2 text-right text-xs text-ink-soft">{result.latencyMs} ms</td>
                              <td className="py-0.5 text-right text-xs text-ink">{detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className={`${kv} mb-1`}>Instrument files</div>
                  {files && files.length > 0 ? (
                    <table className="w-full text-sm">
                      <thead className="bg-raised text-xs uppercase text-ink-faint">
                        <tr>
                          <th className={head}>File</th>
                          <th className={head}>Loaded</th>
                          <th className={`${head} text-right`}>Count</th>
                          <th className={head}>Fetched</th>
                          <th className={head}>Last attempt</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline">
                        {files.map((f) => (
                          <tr key={f.name}>
                            <td className={`${cell} text-xs text-ink`}>
                              {f.name} <span className="text-ink-faint">· {f.kind}</span>
                            </td>
                            <td className={cell}>
                              {f.inProgress ? <Badge tone="info">Fetching</Badge> : f.loaded ? <Badge tone={f.isStale ? 'warning' : 'success'}>{f.isFromToday ? 'Today' : 'Loaded'}</Badge> : <Badge tone="danger">No</Badge>}
                            </td>
                            <td className={`${cell} text-right font-mono text-xs text-ink`}>{fmtNum(f.count)}</td>
                            <td className={`${cell} text-xs text-ink-soft`}>{fmtWhen(f.cachedAt)}</td>
                            <td className={`${cell} text-xs ${f.lastError ? 'text-danger-500' : 'text-ink-soft'}`} title={f.lastError ?? ''}>
                              {f.lastError ?? fmtWhen(f.lastAttemptAt)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="text-xs text-ink-soft">No instrument file is registered yet; they are named at the day's start.</div>
                  )}
                </>
              ) : (
                <Absent />
              )}
            </Panel>

            {/* Loops */}
            <Panel icon={<BsCpu />} title="Engine loops" error={panelError(data.loops)}>
              {loops ? (
                <>
                  <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Metric label="Runner" value={yesNo(loops.runnerRunning, 'Running', 'Stopped', 'danger')} sub="advances every venue's day" />
                    <Metric label="Trade loops" value={yesNo(loops.tradeLoopsStarted, 'Started', 'Not started')} sub={`${loops.accountsCycling.length} account(s) cycling`} />
                    <Metric
                      label="Strategy loop"
                      value={loops.strategyLoop ? yesNo(loops.strategyLoop.running, 'Sweeping', 'Stopped', 'danger') : <Badge tone="neutral">None</Badge>}
                      sub={loops.strategyLoop ? `every ${loops.strategyLoop.intervalSeconds}s · day ${loops.strategyLoop.tradingDay}` : 'nothing subscribed'}
                    />
                    <Metric
                      label="Tranches"
                      value={loops.strategyLoop ? `${loops.strategyLoop.tranchesOpen} open / ${loops.strategyLoop.tranchesToday} today` : '—'}
                      sub={loops.strategyLoop ? `${loops.strategyLoop.strategiesLoaded} strategies · ${loops.strategyLoop.subscriptions} subscriptions loaded` : undefined}
                    />
                  </div>
                  {loops.accountsCycling.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {loops.accountsCycling.map((id) => (
                        <Badge key={id} tone="blue">{id}</Badge>
                      ))}
                    </div>
                  )}
                  {loops.strategyLoop && Object.keys(loops.strategyLoop.refused).length > 0 && (
                    <div className="text-xs">
                      <div className="mb-1 text-ink-soft">Left out of the loop</div>
                      {Object.entries(loops.strategyLoop.refused).map(([name, why]) => (
                        <div key={name} className="text-warning-700 dark:text-warning-400">
                          <strong>{name}</strong>: {why}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <Absent />
              )}
            </Panel>

            {/* Strategies */}
            <Panel icon={<BsDiagram3 />} title="Strategies">
              <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label="Defined" value={fmtNum(data.strategies.definitions.total)} />
                <Metric label="Active" value={<Badge tone="success">{fmtNum(data.strategies.definitions.active)}</Badge>} />
                <Metric label="Winding down" value={<Badge tone="warning">{fmtNum(data.strategies.definitions.windDown)}</Badge>} />
                <Metric label="Inactive" value={<Badge tone="neutral">{fmtNum(data.strategies.definitions.inactive)}</Badge>} />
              </div>
              <div className="mb-3 text-xs text-ink-soft">
                Triggers (overlapping): tick {fmtNum(data.strategies.definitions.tickEnabled)} · scheduled {fmtNum(data.strategies.definitions.scheduledEnabled)} · signal{' '}
                {fmtNum(data.strategies.definitions.signalEnabled)} · periodic {fmtNum(data.strategies.definitions.periodicEnabled)}
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Metric label="Subscriptions" value={fmtNum(data.strategies.subscriptions.total)} />
                <Metric label="Active" value={<Badge tone="success">{fmtNum(data.strategies.subscriptions.active)}</Badge>} />
                <Metric label="Inactive" value={<Badge tone="neutral">{fmtNum(data.strategies.subscriptions.inactive)}</Badge>} />
                <Metric label="Live" value={<Badge tone="blue">{fmtNum(data.strategies.subscriptions.live)}</Badge>} />
                <Metric label="Paper" value={<Badge tone="info">{fmtNum(data.strategies.subscriptions.paper)}</Badge>} />
              </div>
            </Panel>

            {/* Accounts */}
            <Panel
              icon={<BsPeople />}
              title="Trading clients"
              flush
              right={<span className={kv}>{data.accounts.trading} trading · {data.accounts.loggedIn} logged in · {data.accounts.failed} failed · {data.accounts.loggedOut} logged out</span>}
            >
              <table className="w-full text-sm">
                <thead className="bg-raised text-xs uppercase text-ink-faint">
                  <tr>
                    <th className={head}>Account</th>
                    <th className={head}>Session</th>
                    <th className={head}>Trading</th>
                    <th className={head}>Why not</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {data.accounts.rows.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-4 text-center text-xs text-ink-soft">No trading client is configured.</td>
                    </tr>
                  ) : (
                    data.accounts.rows.map((row: AccountRow) => (
                      <tr key={row.tradingClientId}>
                        <td className={`${cell} text-xs text-ink`}>
                          {row.displayName} <span className="text-ink-faint">· {row.broker.toLowerCase()} · {row.clientId}</span>
                          {!row.enabled && <Badge tone="neutral" className="ml-1">disabled</Badge>}
                        </td>
                        <td className={cell} title={row.loginError ?? (row.sessionCreatedOn ? `since ${fmtWhen(row.sessionCreatedOn)}` : '')}>
                          <Badge tone={sessionTone[row.session]}>{sessionWords[row.session]}</Badge>
                        </td>
                        <td className={cell}>
                          {row.isTrading ? <Badge tone="success">{row.isCycling ? 'Cycling' : 'Ready'}</Badge> : <Badge tone="neutral">No</Badge>}
                        </td>
                        <td className={`${cell} text-xs ${row.loginError ? 'text-danger-500' : 'text-ink-soft'}`}>{row.loginError ?? row.unavailableBecause ?? ''}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </Panel>

            {/* Brokers */}
            <Panel icon={<BsBank />} title="Brokers" flush right={<span className={kv}>{data.brokers.enabled} enabled · {data.brokers.stopped} stopped · {data.brokers.total} total</span>}>
              <table className="w-full text-sm">
                <thead className="bg-raised text-xs uppercase text-ink-faint">
                  <tr>
                    <th className={head}>Broker</th>
                    <th className={head}>Enabled</th>
                    <th className={head}>Stopped</th>
                    <th className={`${head} text-right`}>Accounts</th>
                    <th className={`${head} text-right`}>Logged in</th>
                    <th className={`${head} text-right`}>Trading</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {data.brokers.rows.map((b) => (
                    <tr key={b.name}>
                      <td className={`${cell} text-xs capitalize text-ink`}>{b.name}</td>
                      <td className={cell}>{yesNo(b.enabled)}</td>
                      <td className={cell}>{b.stopped ? <Badge tone="danger">Stopped</Badge> : <Badge tone="neutral">No</Badge>}</td>
                      <td className={`${cell} text-right font-mono text-xs text-ink`}>{b.accounts}</td>
                      <td className={`${cell} text-right font-mono text-xs text-ink`}>{b.loggedIn}</td>
                      <td className={`${cell} text-right font-mono text-xs text-ink`}>{b.trading}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            {/* Venues */}
            <Panel icon={<BsGlobe />} title="Venues" flush error={panelError(data.venues)} right={venues && yesNo(venues.anyMarketOpen, 'A market is open', 'All closed')}>
              {venues ? (
                <table className="w-full text-sm">
                  <thead className="bg-raised text-xs uppercase text-ink-faint">
                    <tr>
                      <th className={head}>Venue</th>
                      <th className={head}>Trading day</th>
                      <th className={head}>Open now</th>
                      <th className={head}>Today's sessions</th>
                      <th className={head}>Next phase</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {venues.rows.map((v) => (
                      <tr key={v.code}>
                        <td className={`${cell} text-xs text-ink`}>
                          {v.code} <span className="text-ink-faint">· {v.timezone}</span>
                        </td>
                        <td className={`${cell} text-xs text-ink`}>{v.tradingDay}</td>
                        <td className={cell}>{v.isTradingDay ? yesNo(v.isOpen) : <Badge tone="neutral">Closed today</Badge>}</td>
                        <td className={`${cell} text-xs text-ink-soft`}>{v.sessions.length > 0 ? v.sessions.map((s) => `${s.opens}–${s.closes}`).join(', ') : '—'}</td>
                        <td className={`${cell} text-xs text-ink-soft`}>{v.nextPhase ? `${v.nextPhase.phase} at ${fmtWhen(v.nextPhase.at)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Absent />
              )}
            </Panel>

            {/* Risk */}
            <Panel icon={<BsShieldCheck />} title="Risk">
              <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label="Gate" value={<Badge tone="success">Always on</Badge>} sub="every order passes it" />
                <Metric label="Breaches today" value={<Badge tone={data.risk.breachesToday > 0 ? 'danger' : 'success'}>{fmtNum(data.risk.breachesToday)}</Badge>} />
                <Metric label="Kill switches" value={<Badge tone={data.risk.activeKillSwitches > 0 ? 'danger' : 'success'}>{fmtNum(data.risk.activeKillSwitches)}</Badge>} sub="active today" />
                <Metric label="Limit rows" value={fmtNum(data.risk.limitRows)} sub={data.risk.limitRows === null ? 'needs the engine' : 'loaded into the gate'} />
              </div>
              {data.risk.killSwitches.length > 0 && (
                <div className="mb-3 space-y-1">
                  {data.risk.killSwitches.map((s, i) => (
                    <div key={i} className="text-xs text-danger-600 dark:text-danger-400">
                      <strong>{s.scope}</strong>
                      {s.reason ? ` — ${s.reason}` : ''} <span className="text-ink-faint">({s.source})</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.risk.killSwitchTypes).map(([source, armed]) => (
                  <Badge key={source} tone={armed ? 'warning' : 'neutral'}>
                    {source}: {armed ? 'armed' : 'off'}
                  </Badge>
                ))}
              </div>
              <div className="mt-2 text-xs text-ink-faint">Nothing raises a switch on its own yet; the gate refuses at the limit instead.</div>
            </Panel>

            {/* Timelines */}
            <Timeline icon={<BsPlayCircle />} title="Startup" events={timeline.data?.startup} empty={attached ? 'Nothing recorded yet.' : 'No engine, so no startup to show.'} />
            <div>
              <Timeline icon={<BsCardChecklist />} title="The day" events={timeline.data?.day} empty={attached ? 'No phase has run yet today.' : 'No engine, so no day to show.'} />
              {attached && venues && venues.rows.length > 0 && (
                <div className="-mt-px rounded-b-card border border-t-0 border-hairline bg-card">
                  <RunPhase venues={venues.rows.map((v) => ({ code: v.code, tradingDay: v.tradingDay }))} onRan={refresh} />
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 text-right text-xs text-ink-faint">
            <BsArchive className="mr-1 inline" />
            Snapshot at {fmtWhen(data.generatedAt)} · refreshes every {REFRESH_MS / 1000}s
          </div>
        </>
      ) : null}
    </div>
  );
};

export default SystemStatus;
