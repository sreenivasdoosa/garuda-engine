import { Fragment, useState, Children, cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  Card,
  Button,
  Spinner,
  Alert,
  Row,
  Col,
  Table,
  Badge,
  ProgressBar,
  Collapse,
} from '@/components/ui/rbShim';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  BsArrowClockwise,
  BsActivity,
  BsCpu,
  BsBroadcast,
  BsDiagram3,
  BsPeople,
  BsBank,
  BsGlobe,
  BsShieldCheck,
  BsHddNetwork,
  BsPlayCircle,
  BsCardChecklist,
  BsStack,
  BsDiagram2,
  BsChevronDown,
  BsChevronRight,
  BsArchive,
  // BsClipboardData, // Today Trades badge icon — disabled for performance (see commented card).
} from 'react-icons/bs';
import { toast } from 'react-toastify';

import { PageHeader } from '@/components/common';
import {
  systemStatusService,
  type SystemStatusHealthCheck,
  type InitTimelineEvent,
  type SystemStatusQueue,
  type SystemStatusEviction,
  type SystemStatusArchive,
  type SystemStatusBrokerDist,
  // Today Trades badge disabled for performance (see below) — type unused while commented.
  // type SystemStatusTodayTrades,
} from '@/services/admin/v2AdminService';

const REFRESH_INTERVAL_MS = 15000;

// ---- small presentational helpers ----

const boolBadge = (v: boolean | null | undefined, trueText = 'Yes', falseText = 'No') => {
  if (v === null || v === undefined) return <Badge bg="secondary">n/a</Badge>;
  return <Badge bg={v ? 'success' : 'secondary'}>{v ? trueText : falseText}</Badge>;
};

const tickerStateBadge = (state: string) => {
  const map: Record<string, string> = { UP: 'success', DOWN: 'danger', INACTIVE: 'secondary' };
  return <Badge bg={map[state] ?? 'secondary'}>{state}</Badge>;
};

const fmtUptime = (s?: number) => {
  if (s === undefined || s === null) return '-';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const fmtNum = (n?: number | null) =>
  n === undefined || n === null ? '-' : n.toLocaleString();

const fmtPct = (n?: number | null) =>
  n === undefined || n === null ? '-' : `${n.toFixed(1)}%`;

// A compact metric "chip": label above, value below.
const Metric: React.FC<{ label: string; value: React.ReactNode; sub?: string }> = ({
  label,
  value,
  sub,
}) => (
  <Col xs={6} md={3} className="mb-4">
    <div className="text-ink-soft text-[0.875em] uppercase">{label}</div>
    <div className="font-bold text-base">{value}</div>
    {sub && <div className="text-ink-soft text-[0.875em]">{sub}</div>}
  </Col>
);

// Summary card for the top health strip.
const SummaryCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  badge: React.ReactNode;
  detail: React.ReactNode;
}> = ({ icon, title, badge, detail }) => (
  <Col md={3} className="mb-4">
    <Card className="h-full">
      <Card.Body className="py-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-ink-soft text-[0.875em] uppercase">
            {icon} <span className="ms-1">{title}</span>
          </span>
          {badge}
        </div>
        <div className="font-semibold">{detail}</div>
      </Card.Body>
    </Card>
  </Col>
);

const PanelHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  right?: React.ReactNode;
  // Injected by CollapsibleCard — makes the header a clickable expand/collapse toggle.
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}> = ({ icon, title, right, collapsible, open, onToggle }) => (
  <Card.Header
    className="flex justify-between items-center"
    onClick={collapsible ? onToggle : undefined}
    style={collapsible ? { cursor: 'pointer', userSelect: 'none' } : undefined}
  >
    <h6 className="mb-0">
      {collapsible &&
        (open ? <BsChevronDown className="me-1 text-ink-soft" /> : <BsChevronRight className="me-1 text-ink-soft" />)}
      {icon} <span className="ms-1">{title}</span>
    </h6>
    {/* clicks on the right-side actions (buttons/badges) must not toggle the section */}
    {right && <div onClick={(e) => e.stopPropagation()}>{right}</div>}
  </Card.Header>
);

// localStorage-persisted collapse state per section, so an admin's expand/collapse choices survive
// the 15s auto-refresh and page reloads. Sections default to OPEN unless explicitly collapsed.
const COLLAPSE_LS_KEY = 'systemStatus.collapsedSections';
const readCollapseMap = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_LS_KEY) || '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
};
const useCollapseState = (key: string): [boolean, () => void] => {
  const [open, setOpen] = useState<boolean>(() => readCollapseMap()[key] !== false);
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      const m = readCollapseMap();
      m[key] = next;
      try {
        localStorage.setItem(COLLAPSE_LS_KEY, JSON.stringify(m));
      } catch {
        /* ignore quota / disabled storage */
      }
      return next;
    });
  };
  return [open, toggle];
};

/**
 * Wraps a section so its header (the first child — a PanelHeader) toggles expand/collapse and the
 * rest of the children (the body) animate open/closed. Lets each section be shown/hidden by click,
 * persisted per `sectionKey`. Usage: swap a section's <Card>…</Card> for
 * <CollapsibleCard sectionKey="x">…</CollapsibleCard> — the inner PanelHeader / Card.Body are unchanged.
 */
const CollapsibleCard: React.FC<{ sectionKey: string; className?: string; children: ReactNode }> = ({
  sectionKey,
  className,
  children,
}) => {
  const [open, toggle] = useCollapseState(sectionKey);
  const kids = Children.toArray(children);
  const header = kids[0];
  const body = kids.slice(1);
  const headerWithToggle = isValidElement(header)
    ? cloneElement(header as ReactElement<{ collapsible?: boolean; open?: boolean; onToggle?: () => void }>, {
        collapsible: true,
        open,
        onToggle: toggle,
      })
    : header;
  return (
    <Card className={className}>
      {headerWithToggle}
      <Collapse in={open}>
        <div>{body}</div>
      </Collapse>
    </Card>
  );
};

const InitTimelinePanel: React.FC<{
  icon: React.ReactNode;
  title: string;
  events: InitTimelineEvent[] | undefined;
  emptyText: string;
}> = ({ icon, title, events, emptyText }) => (
  <CollapsibleCard sectionKey={`initTimeline:${title}`}>
    <PanelHeader icon={icon} title={title} right={<Badge bg="secondary">{events?.length ?? 0}</Badge>} />
    <Card.Body className="p-0">
      <Table size="sm" hover responsive className="mb-0">
        <thead>
          <tr>
            <th style={{ whiteSpace: 'nowrap', width: '12rem' }}>Timestamp</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {events && events.length > 0 ? (
            events.map((e, i) => (
              <tr key={i}>
                <td className="text-ink-soft text-[0.875em]" style={{ whiteSpace: 'nowrap' }}>{e.timestamp}</td>
                <td className="text-[0.875em]">{e.message}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2} className="text-ink-soft text-[0.875em] text-center py-4">{emptyText}</td>
            </tr>
          )}
        </tbody>
      </Table>
    </Card.Body>
  </CollapsibleCard>
);

// Group labels for the Queues panel, rendered in this order; any unknown
// group still renders (appended) so a new backend group never goes missing.
const QUEUE_GROUP_ORDER: string[] = [
  'thread-pools',
  'ticker',
  'persistence',
  'trade-log',
  'portal-events',
  'positions',
  'alerts',
  'in-memory-state',
];

// A queue is "hot" at >= 90% utilization (bounded), or — for unbounded queues
// (no capacity) — once a meaningful backlog has built up.
const UNBOUNDED_BACKLOG_WARN = 1000;
const isQueueHot = (q: SystemStatusQueue): boolean => {
  if (q.utilizationPct !== undefined) return q.utilizationPct >= 90;
  return q.size >= UNBOUNDED_BACKLOG_WARN;
};

const QueuesPanel: React.FC<{ queues: SystemStatusQueue[] | undefined }> = ({ queues }) => {
  const rows = queues ?? [];
  const grouped = new Map<string, SystemStatusQueue[]>();
  for (const q of rows) {
    const list = grouped.get(q.group) ?? [];
    list.push(q);
    grouped.set(q.group, list);
  }
  const orderedGroups = [
    ...QUEUE_GROUP_ORDER.filter((g) => grouped.has(g)),
    ...[...grouped.keys()].filter((g) => !QUEUE_GROUP_ORDER.includes(g)),
  ];
  const hotCount = rows.filter(isQueueHot).length;

  return (
    <CollapsibleCard sectionKey="queues" className="mb-4">
      <PanelHeader
        icon={<BsStack />}
        title="Critical-Path Queues"
        right={
          <span className="text-ink-soft text-[0.875em]">
            {rows.length} queues
            {hotCount > 0 && (
              <Badge bg="danger" className="ms-2">
                {hotCount} hot
              </Badge>
            )}
          </span>
        }
      />
      <Card.Body className="p-0">
        {rows.length > 0 ? (
          <Table size="sm" hover responsive className="mb-0">
            <thead>
              <tr>
                <th className="ps-4">Queue</th>
                <th className="text-end">Size</th>
                <th className="text-end">Capacity</th>
                <th style={{ width: '14rem' }}>Util%</th>
                <th className="text-center">Active / Pool</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {orderedGroups.map((group) => (
                <Fragment key={group}>
                  <tr className="bg-raised">
                    <td colSpan={6} className="ps-4 font-semibold uppercase text-[0.875em] text-ink-soft">
                      {group}
                    </td>
                  </tr>
                  {grouped.get(group)!.map((q) => {
                    const hot = isQueueHot(q);
                    const util = q.utilizationPct;
                    return (
                      <tr key={`${group}:${q.name}`} className={hot ? '[&_td]:!bg-danger-500/10' : undefined}>
                        <td className="ps-4">
                          <code>{q.name}</code>
                        </td>
                        <td className="text-end">{fmtNum(q.size)}</td>
                        <td className="text-end text-ink-soft">
                          {q.capacity !== undefined ? fmtNum(q.capacity) : '∞'}
                        </td>
                        <td>
                          {util !== undefined ? (
                            <ProgressBar
                              now={util}
                              variant={util >= 90 ? 'danger' : util >= 75 ? 'warning' : 'success'}
                              label={`${util}%`}
                            />
                          ) : (
                            <span className="text-ink-soft text-[0.875em]">unbounded</span>
                          )}
                        </td>
                        <td className="text-center text-[0.875em] text-ink-soft">
                          {q.activeCount !== undefined && q.poolSize !== undefined
                            ? `${q.activeCount} / ${q.poolSize}`
                            : '-'}
                        </td>
                        <td className="text-[0.875em] text-ink-soft">
                          {q.note}
                          {q.droppedTotal !== undefined && q.droppedTotal > 0 && (
                            <Badge bg="warning" text="dark" className="ms-2">
                              {fmtNum(q.droppedTotal)} dropped
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="text-ink-soft text-[0.875em] p-4">No queue stats available.</div>
        )}
      </Card.Body>
    </CollapsibleCard>
  );
};

// Cumulative active-in-memory eviction counts (trades + signals separately) for the current window
// (since app restart; reset to 0 at the morning day-init).
const EvictionPanel: React.FC<{ eviction: SystemStatusEviction | undefined }> = ({ eviction }) => (
  <CollapsibleCard sectionKey="eviction" className="mb-4">
    <PanelHeader
      icon={<BsStack />}
      title="Active-Trade Eviction"
      right={<span className="text-ink-soft text-[0.875em]">since {eviction?.since ?? 'app restart'}</span>}
    />
    <Card.Body>
      {eviction?.error ? (
        <div className="text-ink-soft text-[0.875em]">Unavailable: {eviction.error}</div>
      ) : (
        <Row>
          <Metric label="Trades Evicted" value={fmtNum(eviction?.evictedTrades)} />
          <Metric label="Trade Signals Evicted" value={fmtNum(eviction?.evictedTradeSignals)} />
        </Row>
      )}
    </Card.Body>
  </CollapsibleCard>
);

// Live-trade day-rollover archive: the LiveTradeArchiveJob's last-run result + current archive-table
// row counts. The job moves prior-day evicted-terminal LIVE_TRADES/SIGNALS rows to the archive tables,
// keeps them N days, then hard-purges — managed from Administration → Data Retention.
const archiveStateBadge = (state?: string) => {
  const map: Record<string, string> = {
    IDLE: 'secondary', RUNNING: 'primary', DONE: 'success', FAILED: 'danger', CANCELLED: 'warning',
  };
  return <Badge bg={map[state ?? 'IDLE'] ?? 'secondary'}>{state ?? 'IDLE'}</Badge>;
};

const ArchivePanel: React.FC<{ archive: SystemStatusArchive | undefined }> = ({ archive }) => (
  <CollapsibleCard sectionKey="archive" className="mb-4">
    <PanelHeader
      icon={<BsArchive />}
      title="Live Trade Archive"
      right={archiveStateBadge(archive?.state)}
    />
    <Card.Body>
      {archive?.error ? (
        <div className="text-ink-soft text-[0.875em]">Unavailable: {archive.error}</div>
      ) : (
        <>
          <Row>
            <Metric label="Archived Trades (total)" value={fmtNum(archive?.archivedTradesTotal)} />
            <Metric label="Archived Signals (total)" value={fmtNum(archive?.archivedSignalsTotal)} />
            <Metric label="Retention" value={`${fmtNum(archive?.retentionDays)} days`}
              sub={archive?.enabled ? 'enabled' : 'disabled'} />
          </Row>
          <Row className="mt-2">
            <Metric label="Last Run" value={archive?.lastFinishedAt ?? archive?.lastStartedAt ?? '—'}
              sub={archive?.trigger ? `trigger: ${archive.trigger}` : undefined} />
            <Metric label="Last Archived"
              value={`${fmtNum(archive?.lastTradesArchived)} trades · ${fmtNum(archive?.lastSignalsArchived)} signals`} />
            <Metric label="Last Purged"
              value={`${fmtNum(archive?.lastTradesPurged)} trades · ${fmtNum(archive?.lastSignalsPurged)} signals`} />
          </Row>
          {archive?.lastError ? (
            <div className="text-danger-600 dark:text-danger-400 text-[0.875em] mt-2">Last error: {archive.lastError}</div>
          ) : null}
        </>
      )}
    </Card.Body>
  </CollapsibleCard>
);

// Per-broker distribution of the resident working set + order-book freshness,
// so a stuck/laggard broker (stale order books) stands out from the rest.
const fmtFetchAge = (sec: number | null): string => {
  if (sec === null || sec === undefined) return 'never';
  if (sec < 90) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 90) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

const BrokerDistributionPanel: React.FC<{ rows: SystemStatusBrokerDist[] | undefined }> = ({
  rows,
}) => {
  const list = rows ?? [];
  const laggardCount = list.filter((r) => r.laggard).length;

  return (
    <CollapsibleCard sectionKey="brokerDist" className="mb-4">
      <PanelHeader
        icon={<BsDiagram2 />}
        title="Per-Broker Distribution"
        right={
          <span className="text-ink-soft text-[0.875em]">
            {list.length} brokers
            {laggardCount > 0 && (
              <Badge bg="danger" className="ms-2">
                {laggardCount} laggard
              </Badge>
            )}
          </span>
        }
      />
      <Card.Body className="p-0">
        {list.length > 0 ? (
          <Table size="sm" hover responsive className="mb-0">
            <thead>
              <tr>
                <th className="ps-4">Broker</th>
                <th className="text-end">User-Brokers</th>
                <th className="text-end" title="All Trade objects held in memory (open + active + terminal-not-yet-evicted)">In Memory Trades</th>
                <th className="text-end" title="Non-terminal trades (open + active) — the set still being tracked">Active</th>
                <th className="text-end" title="Terminal trades still in memory (In Memory − Active) — eviction backlog, drains as groups close">Terminal (mem)</th>
                <th className="text-end" title="All TradeSignal objects held in memory">In Memory Signals</th>
                <th className="text-end" title="In Memory Signals ÷ In Memory Trades — signals are not evicted (TODO), so this climbs over the day">Sig/Trade</th>
                <th className="text-end">OB Stale</th>
                <th className="text-end">OB Oldest Fetch</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.broker} className={r.laggard ? '[&_td]:!bg-danger-500/10' : undefined}>
                  <td className="ps-4">
                    <code>{r.broker}</code>
                    {r.laggard && (
                      <Badge bg="danger" className="ms-2">
                        laggard
                      </Badge>
                    )}
                  </td>
                  <td className="text-end">{fmtNum(r.userBrokers)}</td>
                  <td className="text-end">{fmtNum(r.residentTrades)}</td>
                  <td className="text-end">{fmtNum(r.activeTrades)}</td>
                  <td className="text-end text-ink-soft">{fmtNum(Math.max(0, r.residentTrades - r.activeTrades))}</td>
                  <td className="text-end">{fmtNum(r.residentSignals)}</td>
                  <td className="text-end text-ink-soft">
                    {r.residentTrades > 0 ? (r.residentSignals / r.residentTrades).toFixed(1) : '-'}
                  </td>
                  <td className="text-end">
                    {r.orderBookStaleCount > 0 ? (
                      <Badge bg="warning" text="dark">
                        {fmtNum(r.orderBookStaleCount)}
                      </Badge>
                    ) : (
                      <span className="text-ink-soft">0</span>
                    )}
                  </td>
                  <td className="text-end text-[0.875em] text-ink-soft">
                    {fmtFetchAge(r.orderBookOldestFetchAgeSec)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="text-ink-soft text-[0.875em] p-4">No per-broker distribution available.</div>
        )}
      </Card.Body>
    </CollapsibleCard>
  );
};

const SystemStatus: React.FC = () => {
  const [probe, setProbe] = useState<SystemStatusHealthCheck | null>(null);

  const { data, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['system-status'],
    queryFn: () => systemStatusService.getStatus(),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  // Startup / daily-init timeline (independent of the snapshot — always shown).
  const { data: initTimeline } = useQuery({
    queryKey: ['system-status', 'init-timeline'],
    queryFn: () => systemStatusService.getInitTimeline(),
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  const probeMutation = useMutation({
    mutationFn: () => systemStatusService.runHealthCheck(),
    onSuccess: (res) => {
      setProbe(res);
      const ok = res.quote.ok && res.history.ok;
      if (ok) toast.success('Market-data probe OK');
      else toast.warning('Market-data probe reported a failure');
    },
    onError: (e: Error) => toast.error(e.message || 'Probe failed'),
  });

  if (error) {
    return (
      <div className="fade-in">
        <PageHeader title="System Status" subtitle="Live core trading app status" />
        <Alert variant="danger">Failed to load system status: {(error as Error).message}</Alert>
      </div>
    );
  }

  const rt = data?.runtime;
  const sizing = data?.sizing;
  const http = data?.httpServer;
  const ws = data?.websocket;
  const tp = data?.tradeProcessors;
  // Today Trades badge disabled for performance (see the commented SummaryCard below).
  // const tt: SystemStatusTodayTrades | undefined = data?.todayTrades;
  const tk = data?.ticker;
  const se = data?.strategyEngine;
  const subs = data?.subscriptions;
  const ub = data?.userBrokers;
  const brokers = data?.brokers;
  const exch = data?.exchanges;
  const rms = data?.rms;
  const lic = data?.licenses;

  const heapPct = rt && rt.heapMaxMb ? Math.round((rt.heapUsedMb / rt.heapMaxMb) * 100) : 0;
  // Prefer /proc/meminfo (MemTotal/MemAvailable) — matches htop/free, i.e.
  // used = total - available (buff/cache counts as available, not used).
  // Fall back to JMX total-free only when /proc/meminfo isn't present.
  const sysMemTotalMb = rt?.systemMemoryTotalMb ?? rt?.totalPhysicalMemoryMb;
  const physUsedMb =
    rt?.systemMemoryUsedMb !== undefined
      ? rt.systemMemoryUsedMb
      : rt && rt.totalPhysicalMemoryMb && rt.freePhysicalMemoryMb !== undefined
        ? rt.totalPhysicalMemoryMb - rt.freePhysicalMemoryMb
        : undefined;
  const physPct =
    sysMemTotalMb && physUsedMb !== undefined
      ? Math.round((physUsedMb / sysMemTotalMb) * 100)
      : undefined;
  const fdPct =
    rt && rt.maxFileDescriptors && rt.openFileDescriptors !== undefined && rt.maxFileDescriptors > 0
      ? Math.round((rt.openFileDescriptors / rt.maxFileDescriptors) * 100)
      : undefined;

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '-';

  return (
    <div className="fade-in">
      <PageHeader
        title="System Status"
        subtitle="Live, end-to-end status of the core trading app"
        actions={
          <div className="flex items-center gap-2">
            <span className="text-ink-soft text-[0.875em]">
              Updated {lastUpdated}
              {isFetching && <Spinner animation="border" size="sm" className="ms-2" />}
            </span>
            <Button variant="outline-secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <BsArrowClockwise className={isFetching ? 'spin' : ''} />
              <span className="ms-1">Refresh</span>
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <div className="text-center py-12">
          <Spinner animation="border" variant="primary" />
          <span className="ms-2 text-ink-soft">Loading system status...</span>
        </div>
      ) : (
        <>
          {/* ===== Health summary strip ===== */}
          <Row className=" mb-2">
            <SummaryCard
              icon={<BsBroadcast />}
              title="Market Data"
              badge={tk ? tickerStateBadge(tk.state) : null}
              detail={
                <span className="text-[0.875em] text-ink-soft">
                  {tk?.name ?? '-'} · {fmtNum(tk?.registeredSymbols)} symbols
                </span>
              }
            />
            <SummaryCard
              icon={<BsCpu />}
              title="Trade Processors"
              badge={boolBadge(tp?.initialized, 'Up', 'Down')}
              detail={
                <span className="text-[0.875em] text-ink-soft">
                  {fmtNum(tp?.count)} processors · {fmtNum(tp?.distinctUsers)} users
                </span>
              }
            />
            {/*
              Today Trades badge — DISABLED for performance (2026-06-19). It made the System Status
              page load slowly / hang: the server-side count (completed-today DB COUNT over ~277K
              LIVE_TRADES + the in-memory active sum) ran on the snapshot request thread. The server
              now returns zeros for todayTrades and this card is commented out so it isn't shown at
              all. Re-enable here together with the server-side buildTodayTrades() block (and the
              `tt` const + SystemStatusTodayTrades import above) once the count is made cheap
              (background refresh / maintained counter).
            <SummaryCard
              icon={<BsClipboardData />}
              title="Today Trades"
              badge={<Badge bg="primary">{fmtNum(tt?.total)}</Badge>}
              detail={
                <span className="small text-muted">
                  {fmtNum(tt?.active)} active · {fmtNum(tt?.completed)} completed
                </span>
              }
            />
            */}
            <SummaryCard
              icon={<BsDiagram3 />}
              title="Strategy Engine"
              badge={boolBadge(
                !!se?.engines?.some((e) => e.running),
                'Running',
                'Stopped',
              )}
              detail={
                <span className="text-[0.875em] text-ink-soft">
                  {fmtNum(se?.engines?.length)} engines · {fmtNum(se?.definitions?.active)} active strat.
                </span>
              }
            />
            <SummaryCard
              icon={<BsShieldCheck />}
              title="RMS"
              badge={boolBadge(rms?.effectiveEnabled, 'Enabled', 'Disabled')}
              detail={
                <span className="text-[0.875em] text-ink-soft">
                  {fmtNum(rms?.activeKillSwitches)} kill-switches · {fmtNum(rms?.breachesToday)} breaches today
                </span>
              }
            />
          </Row>

          {/* ===== Runtime & Resources (full width) ===== */}
          <CollapsibleCard sectionKey="runtime" className="mb-4">
            <PanelHeader
              icon={<BsActivity />}
              title="Runtime & Resources"
              right={
                <span className="text-ink-soft text-[0.875em]">
                  v{rt?.version}
                  {rt?.gitHash ? ` (${rt.gitHash})` : ''} · {rt?.mode} · up {fmtUptime(rt?.uptimeSeconds)}
                </span>
              }
            />
            <Card.Body>
              <Row>
                <Metric label="JVM Heap" value={`${fmtNum(rt?.heapUsedMb)} / ${fmtNum(rt?.heapMaxMb)} MB`}
                  sub={`${heapPct}%`} />
                <Metric
                  label="Process RAM (RSS)"
                  value={rt?.processRssMb !== undefined ? `${fmtNum(rt?.processRssMb)} MB` : '-'}
                />
                <Metric
                  label="System RAM"
                  value={
                    physUsedMb !== undefined && sysMemTotalMb
                      ? `${fmtNum(physUsedMb)} / ${fmtNum(sysMemTotalMb)} MB`
                      : '-'
                  }
                  sub={physPct !== undefined ? `${physPct}% used` : undefined}
                />
                <Metric label="Process CPU" value={fmtPct(rt?.processCpuLoadPct)} />
                <Metric label="System CPU" value={fmtPct(rt?.systemCpuLoadPct)}
                  sub={rt?.systemLoadAverage != null ? `load ${rt.systemLoadAverage}` : undefined} />
                <Metric label="Threads" value={fmtNum(rt?.threadCount)}
                  sub={`peak ${fmtNum(rt?.peakThreadCount)} · ${fmtNum(rt?.daemonThreadCount)} daemon · ${fmtNum(rt?.totalStartedThreadCount)} started`} />
                <Metric
                  label="File Descriptors"
                  value={
                    rt?.openFileDescriptors !== undefined
                      ? `${fmtNum(rt?.openFileDescriptors)} / ${fmtNum(rt?.maxFileDescriptors)}`
                      : '-'
                  }
                  sub={fdPct !== undefined ? `${fdPct}%` : undefined}
                />
                <Metric label="Open Sockets" value={fmtNum(rt?.openSocketCount)} />
                <Metric label="CPU Cores" value={fmtNum(rt?.availableProcessors)} />
              </Row>
              <Row className=" mt-1">
                <Col md={4}>
                  <div className="text-ink-soft text-[0.875em] mb-1">Heap usage</div>
                  <ProgressBar
                    now={heapPct}
                    variant={heapPct > 90 ? 'danger' : heapPct > 75 ? 'warning' : 'success'}
                    label={`${heapPct}%`}
                  />
                </Col>
                {physPct !== undefined && (
                  <Col md={4}>
                    <div className="text-ink-soft text-[0.875em] mb-1">System RAM</div>
                    <ProgressBar
                      now={physPct}
                      variant={physPct > 90 ? 'danger' : physPct > 75 ? 'warning' : 'info'}
                      label={`${physPct}%`}
                    />
                  </Col>
                )}
                {fdPct !== undefined && (
                  <Col md={4}>
                    <div className="text-ink-soft text-[0.875em] mb-1">File descriptors</div>
                    <ProgressBar
                      now={fdPct}
                      variant={fdPct > 90 ? 'danger' : fdPct > 75 ? 'warning' : 'success'}
                      label={`${fdPct}%`}
                    />
                  </Col>
                )}
              </Row>
              {data?.threadsByPrefix && Object.keys(data.threadsByPrefix).length > 0 && (
                <Row className=" mt-1">
                  <Col md={12}>
                    <div className="text-ink-soft text-[0.875em] mb-1">
                      Threads by prefix (a pool that grows across refreshes is leaking;
                      a flat count while “started” climbs is short-lived churn)
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(data.threadsByPrefix).map(([name, count]) => (
                        <span key={name} className="inline-block rounded-md px-[.55em] py-[.35em] text-center text-[.75em] font-semibold leading-none whitespace-nowrap bg-raised text-ink-soft border">
                          {name} <strong className="ms-1">{fmtNum(count)}</strong>
                        </span>
                      ))}
                    </div>
                  </Col>
                </Row>
              )}
            </Card.Body>
          </CollapsibleCard>

          {/* ===== HTTP Server (Jetty) — request-serving connector (NOT WebSockets) ===== */}
          {http && http.available && (
            <CollapsibleCard sectionKey="http" className="mb-4">
              <PanelHeader icon={<BsHddNetwork />} title="HTTP Server (Jetty)" />
              <Card.Body>
                <Row>
                  <Metric label="Port" value={fmtNum(http.port)} />
                  <Metric label="Requests (in-flight)" value={fmtNum(http.currentConnections)}
                    sub="HTTP only — WS below" />
                  <Metric label="Peak Requests" value={fmtNum(http.peakConnections)} />
                  <Metric label="Total Requests" value={fmtNum(http.totalConnections)} sub="since restart" />
                  <Metric
                    label="Threads (busy/total)"
                    value={`${fmtNum(http.busyThreads)} / ${fmtNum(http.threads)}`}
                    sub={`max ${fmtNum(http.maxThreads)} · min ${fmtNum(http.minThreads)}`}
                  />
                  <Metric label="Idle Threads" value={fmtNum(http.idleThreads)} />
                  <Metric label="Queue Size" value={fmtNum(http.queueSize)} />
                </Row>
              </Card.Body>
            </CollapsibleCard>
          )}

          {/* ===== WebSocket (live clients) — the real parallel-client connections ===== */}
          {ws && (
            <CollapsibleCard sectionKey="websocket" className="mb-4">
              <PanelHeader icon={<BsHddNetwork />} title="WebSocket (live clients)" />
              <Card.Body>
                <Row>
                  <Metric label="Sockets (now)" value={fmtNum(ws.currentSockets)} />
                  <Metric label="Peak Sockets" value={fmtNum(ws.peakSockets)} sub="max parallel, since restart" />
                  <Metric label="Connected" value={fmtNum(ws.connectedSockets)} />
                  <Metric label="Portal / Supervisor"
                    value={`${fmtNum(ws.portalSockets)} / ${fmtNum(ws.supervisorSockets)}`} />
                  <Metric label="Total Connects" value={fmtNum(ws.totalConnects)} sub="cumulative" />
                  <Metric label="Total Disconnects" value={fmtNum(ws.totalDisconnects)} sub="cumulative" />
                  <Metric label="Portal Subscribers" value={fmtNum(ws.portalSubscribers)}
                    sub={`scoped users ${fmtNum(ws.scopedUsers)}`} />
                  <Metric label="Errors" value={fmtNum(ws.totalErrors)} sub={ws.lastError ?? undefined} />
                  <Metric label="Backpressure"
                    value={`depth ${fmtNum(ws.backpressure?.maxOutboundDepth)}`}
                    sub={`dropped ${fmtNum(ws.backpressure?.droppedOutboundTotal)}`} />
                </Row>
                {ws.closeCodes && Object.keys(ws.closeCodes).length > 0 && (
                  <>
                    <div className="text-ink-soft text-[0.875em] uppercase mb-1">Close codes (why sockets dropped)</div>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(ws.closeCodes).map(([code, count]) => (
                        <Badge key={code} bg="secondary">{code}: {fmtNum(count)}</Badge>
                      ))}
                    </div>
                  </>
                )}
              </Card.Body>
            </CollapsibleCard>
          )}

          {/* ===== Critical-path queue depths ===== */}
          <QueuesPanel queues={data?.queues} />

          {/* ===== Active-in-memory eviction counters ===== */}
          <EvictionPanel eviction={data?.eviction} />

          {/* ===== Live-trade day-rollover archive ===== */}
          <ArchivePanel archive={data?.archive} />

          {/* ===== Per-broker distribution (laggard detection) ===== */}
          <BrokerDistributionPanel rows={data?.brokerDistribution} />

          {/* ===== Thread & Pool Sizing (full width) — all derived from cores ===== */}
          <Row className=" mb-4">
            <Col xs={12}>
              <CollapsibleCard sectionKey="sizing">
                <PanelHeader icon={<BsDiagram3 />} title="Thread & Pool Sizing" />
                <Card.Body>
                  <Row className="mb-2">
                    <Metric label="CPU Cores" value={fmtNum(sizing?.cores)} />
                    <Metric label="DB-Bound Parallelism" value={fmtNum(sizing?.dbBoundParallelism)}
                      sub="boot-load / completion writers / UBTM-init" />
                    <Metric label="DB Max Connections" value={fmtNum(sizing?.dbMaxConnections)} />
                    <Metric label="Square-Off Workers" value={fmtNum(sizing?.squareOffWorkerThreads)} />
                  </Row>
                  <Row className="mb-2">
                    <Metric label="TradeProc Count" value={fmtNum(sizing?.tradeProcessors?.count)}
                      sub="≈ cores × ioFactor" />
                    <Metric label="TradeProc ioFactor" value={sizing?.tradeProcessors?.ioFactor ?? '-'} />
                    <Metric label="Per-Processor Cap" value={fmtNum(sizing?.tradeProcessors?.perProcessorCapacity)}
                      sub="even user-broker share" />
                  </Row>
                  <div className="text-ink-soft text-[0.875em] uppercase mb-2">Engine pools (threads)</div>
                  <Row>
                    <Metric label="tick" value={fmtNum(sizing?.enginePools?.tick)} />
                    <Metric label="scheduled" value={fmtNum(sizing?.enginePools?.scheduled)} />
                    <Metric label="signal" value={fmtNum(sizing?.enginePools?.signal)} />
                    <Metric label="hedge" value={fmtNum(sizing?.enginePools?.hedge)} />
                    <Metric label="misc" value={fmtNum(sizing?.enginePools?.misc)} />
                    <Metric label="scheduler" value={fmtNum(sizing?.enginePools?.scheduler)} />
                  </Row>
                </Card.Body>
              </CollapsibleCard>
            </Col>
          </Row>

          {/* ===== Row: Trade Processors | Market Data Feed ===== */}
          <Row className=" mb-4">
            <Col md={6}>
              <CollapsibleCard sectionKey="tradeProcessors">
                <PanelHeader icon={<BsCpu />} title="Trade Processors" />
                <Card.Body>
                  <Row className="mb-2">
                    <Metric label="Processors" value={fmtNum(tp?.count)} />
                    <Metric label="User-Brokers" value={fmtNum(tp?.totalUserBrokers)} />
                    <Metric label="Active" value={fmtNum(tp?.activeUserBrokers)} />
                    <Metric label="Frozen" value={fmtNum(tp?.frozenUserBrokers)} />
                  </Row>
                  {tp?.processors && tp.processors.length > 0 ? (
                    <Table size="sm" hover responsive className="mb-0">
                      <thead>
                        <tr>
                          <th>Processor</th>
                          <th className="text-center">Running</th>
                          <th className="text-center">User-Brokers</th>
                          <th className="text-center">Active Trades</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tp.processors.map((p) => (
                          <tr key={p.name}>
                            <td>{p.name}</td>
                            <td className="text-center">{boolBadge(p.running, 'Yes', 'No')}</td>
                            <td className="text-center">
                              {p.activeUserBrokers}/{p.userBrokerCount}
                            </td>
                            <td className="text-center">{p.activeTrades}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <div className="text-ink-soft text-[0.875em]">Not initialized (no processors running).</div>
                  )}
                </Card.Body>
              </CollapsibleCard>
            </Col>

            <Col md={6}>
              <CollapsibleCard sectionKey="marketData">
                <PanelHeader
                  icon={<BsBroadcast />}
                  title="Market Data Feed"
                  right={
                    <Button
                      variant="outline-primary"
                      size="sm"
                      onClick={() => probeMutation.mutate()}
                      disabled={probeMutation.isPending}
                    >
                      {probeMutation.isPending ? (
                        <Spinner size="sm" />
                      ) : (
                        <>
                          <BsPlayCircle className="me-1" />
                          Run quote/history check
                        </>
                      )}
                    </Button>
                  }
                />
                <Card.Body>
                  <Row className="mb-2">
                    <Metric label="State" value={tk ? tickerStateBadge(tk.state) : '-'} />
                    <Metric label="Connected" value={boolBadge(tk?.connected)} />
                    <Metric label="Market Open" value={boolBadge(tk?.marketOpen)} />
                    <Metric label="Symbols" value={fmtNum(tk?.registeredSymbols)} />
                  </Row>
                  <div className="text-[0.875em] text-ink-soft mb-2">
                    Feed: <code>{tk?.name ?? '-'}</code> · Last tick:{' '}
                    {tk?.lastTickAt ? <code>{tk.lastTickAt}</code> : <span>none</span>}
                  </div>

                  {probe && (
                    <div className="border rounded-md p-2 mt-2">
                      <div className="text-[0.875em] font-semibold mb-1">
                        Probe: {probe.symbol} <Badge bg="light" text="dark">{probe.providerMode}</Badge>
                      </div>
                      <Table size="sm" borderless className="mb-0">
                        <tbody>
                          <tr>
                            <td>Quote</td>
                            <td>{boolBadge(probe.quote.ok, 'OK', 'FAIL')}</td>
                            <td className="text-end text-[0.875em] text-ink-soft">{probe.quote.latencyMs} ms</td>
                            <td className="text-end">
                              {probe.quote.ok
                                ? `₹${probe.quote.lastPrice?.toLocaleString()}`
                                : probe.quote.error}
                            </td>
                          </tr>
                          <tr>
                            <td>History</td>
                            <td>{boolBadge(probe.history.ok, 'OK', 'FAIL')}</td>
                            <td className="text-end text-[0.875em] text-ink-soft">{probe.history.latencyMs} ms</td>
                            <td className="text-end">
                              {probe.history.ok
                                ? `${probe.history.candles} candles (${probe.history.interval})`
                                : probe.history.error}
                            </td>
                          </tr>
                        </tbody>
                      </Table>
                    </div>
                  )}
                </Card.Body>
              </CollapsibleCard>
            </Col>
          </Row>

          {/* ===== Row: Strategy Engine | Subscriptions ===== */}
          <Row className=" mb-4">
            <Col md={6}>
              <CollapsibleCard sectionKey="strategyEngine">
                <PanelHeader icon={<BsDiagram3 />} title="Strategy Engine" />
                <Card.Body>
                  <Row className="mb-2">
                    <Metric label="Total Strategies" value={fmtNum(se?.definitions?.total)} />
                    <Metric label="Active" value={fmtNum(se?.definitions?.active)} />
                    <Metric label="Wind-Down" value={fmtNum(se?.definitions?.windDown)} />
                    <Metric label="Inactive" value={fmtNum(se?.definitions?.inactive)} />
                  </Row>
                  <div className="text-[0.875em] text-ink-soft mb-2">
                    Triggers (overlapping): signal {fmtNum(se?.definitions?.signalEnabled)} · scheduled{' '}
                    {fmtNum(se?.definitions?.scheduledEnabled)} · tick {fmtNum(se?.definitions?.tickEnabled)} ·
                    periodic {fmtNum(se?.definitions?.periodicEnabled)} · mock {fmtNum(se?.definitions?.mock)}
                  </div>
                  {se?.engines && se.engines.length > 0 ? (
                    <Table size="sm" hover responsive className="mb-0">
                      <thead>
                        <tr>
                          <th>Exchange</th>
                          <th className="text-center">Running</th>
                          <th className="text-center">Dry-Run</th>
                          <th className="text-center">Active Subs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {se.engines.map((e) => (
                          <tr key={e.exchange}>
                            <td>{e.exchange}</td>
                            <td className="text-center">{boolBadge(e.running, 'Yes', 'No')}</td>
                            <td className="text-center">{boolBadge(e.dryRun, 'Yes', 'No')}</td>
                            <td className="text-center">{e.activeSubscriptions}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <div className="text-ink-soft text-[0.875em]">No active engines.</div>
                  )}
                </Card.Body>
              </CollapsibleCard>
            </Col>

            <Col md={6}>
              <CollapsibleCard sectionKey="subscriptions">
                <PanelHeader icon={<BsCardChecklist />} title="Subscriptions" />
                <Card.Body>
                  <Row>
                    <Metric label="Total" value={fmtNum(subs?.total)} />
                    <Metric label="Active" value={<Badge bg="success">{fmtNum(subs?.active)}</Badge>} />
                    <Metric label="Inactive" value={<Badge bg="secondary">{fmtNum(subs?.inactive)}</Badge>} />
                    <Metric label="" value="" />
                    <Metric label="Live" value={<Badge bg="primary">{fmtNum(subs?.live)}</Badge>} />
                    <Metric label="Paper" value={<Badge bg="info">{fmtNum(subs?.paper)}</Badge>} />
                  </Row>
                </Card.Body>
              </CollapsibleCard>
            </Col>
          </Row>

          {/* ===== Row: User Brokers | Brokers ===== */}
          <Row className=" mb-4">
            <Col md={6}>
              <CollapsibleCard sectionKey="userBrokers">
                <PanelHeader icon={<BsPeople />} title="User Brokers (login status)" />
                <Card.Body>
                  <Row>
                    <Metric label="Configured" value={fmtNum(ub?.configured)} />
                    <Metric label="Logged In" value={<Badge bg="success">{fmtNum(ub?.loggedIn)}</Badge>} />
                    <Metric label="Failed" value={<Badge bg="danger">{fmtNum(ub?.failed)}</Badge>} />
                    <Metric label="Logged Out" value={<Badge bg="secondary">{fmtNum(ub?.loggedOut)}</Badge>} />
                  </Row>
                </Card.Body>
              </CollapsibleCard>
            </Col>

            <Col md={6}>
              <CollapsibleCard sectionKey="brokers">
                <PanelHeader
                  icon={<BsBank />}
                  title="Brokers"
                  right={
                    <span className="text-ink-soft text-[0.875em]">
                      {fmtNum(brokers?.enabled)} enabled / {fmtNum(brokers?.total)} total
                    </span>
                  }
                />
                <Card.Body className="p-0">
                  {brokers?.perBroker && brokers.perBroker.length > 0 ? (
                    <Table size="sm" hover responsive className="mb-0">
                      <thead>
                        <tr>
                          <th className="ps-4">Broker</th>
                          <th className="text-center">Enabled</th>
                          <th className="text-center">Server Running</th>
                          <th className="text-center">Logged-In Users</th>
                        </tr>
                      </thead>
                      <tbody>
                        {brokers.perBroker.map((b) => (
                          <tr key={b.name}>
                            <td className="ps-4 capitalize">{b.name}</td>
                            <td className="text-center">{boolBadge(b.enabled)}</td>
                            <td className="text-center">{boolBadge(b.serverRunning)}</td>
                            <td className="text-center">{b.loggedInUsers}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <div className="text-ink-soft text-[0.875em] p-4">No brokers configured.</div>
                  )}
                </Card.Body>
              </CollapsibleCard>
            </Col>
          </Row>

          {/* ===== Row: Exchanges | RMS ===== */}
          <Row className=" mb-4">
            <Col md={6}>
              <CollapsibleCard sectionKey="exchanges">
                <PanelHeader
                  icon={<BsGlobe />}
                  title="Exchanges"
                  right={<span className="text-ink-soft text-[0.875em]">{boolBadge(exch?.anyMarketOpen, 'Market Open', 'All Closed')}</span>}
                />
                <Card.Body className="p-0">
                  {exch?.perExchange && exch.perExchange.length > 0 ? (
                    <Table size="sm" hover responsive className="mb-0">
                      <thead>
                        <tr>
                          <th className="ps-4">Exchange</th>
                          <th className="text-center">Active</th>
                          <th className="text-center">Open Now</th>
                          <th className="text-center">Holiday</th>
                          <th className="text-center">Hours</th>
                        </tr>
                      </thead>
                      <tbody>
                        {exch.perExchange.map((e) => (
                          <tr key={e.exchange}>
                            <td className="ps-4">{e.exchange}</td>
                            <td className="text-center">{boolBadge(e.active)}</td>
                            <td className="text-center">{boolBadge(e.openNow)}</td>
                            <td className="text-center">{boolBadge(e.holidayToday, 'Yes', 'No')}</td>
                            <td className="text-center text-[0.875em] text-ink-soft">
                              {e.marketOpen?.slice(0, 5)}–{e.marketClose?.slice(0, 5)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <div className="text-ink-soft text-[0.875em] p-4">No active exchanges.</div>
                  )}
                </Card.Body>
              </CollapsibleCard>
            </Col>

            <Col md={6}>
              <CollapsibleCard sectionKey="rms">
                <PanelHeader icon={<BsShieldCheck />} title="RMS (Risk Management)" />
                <Card.Body>
                  <Row className="mb-2">
                    <Metric label="Effective" value={boolBadge(rms?.effectiveEnabled, 'Enabled', 'Disabled')} />
                    <Metric label="Runtime Flag" value={boolBadge(rms?.runtimeEnabled)} />
                    <Metric label="Config Flag" value={boolBadge(rms?.configEnabled)} />
                    <Metric
                      label="Breaches Today"
                      value={
                        <Badge bg={rms?.breachesToday ? 'danger' : 'success'}>
                          {fmtNum(rms?.breachesToday)}
                        </Badge>
                      }
                    />
                  </Row>
                  <div className="text-[0.875em] text-ink-soft mb-1">
                    Active kill-switches: <strong>{fmtNum(rms?.activeKillSwitches)}</strong>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {rms?.killSwitchTypes &&
                      Object.entries(rms.killSwitchTypes).map(([k, v]) => (
                        <Badge key={k} bg={v ? 'warning' : 'light'} text={v ? 'dark' : 'muted'}>
                          {k}: {v ? 'armed' : 'off'}
                        </Badge>
                      ))}
                  </div>
                </Card.Body>
              </CollapsibleCard>
            </Col>
          </Row>

          {/* ===== Row: Licenses ===== */}
          <Row className=" mb-4">
            <Col md={6}>
              <CollapsibleCard sectionKey="licenses">
                <PanelHeader icon={<BsHddNetwork />} title="User-Broker Licenses" />
                <Card.Body>
                  <Row>
                    <Metric label="Assigned" value={fmtNum(lic?.assignedCount)} />
                    <Metric label="Active" value={<Badge bg="success">{fmtNum(lic?.activeCount)}</Badge>} />
                    <Metric label="Cache Valid" value={boolBadge(lic?.cacheValid)} />
                    <Metric label="Server" value={boolBadge(lic?.serverConfigured, 'Configured', 'No')} />
                  </Row>
                  {lic?.lastHeartbeat && (
                    <div className="text-[0.875em] text-ink-soft">Last heartbeat: <code>{lic.lastHeartbeat}</code></div>
                  )}
                </Card.Body>
              </CollapsibleCard>
            </Col>
          </Row>

          <div className="text-ink-soft text-[0.875em] text-end mb-4">
            Snapshot generated at {data?.generatedAt} · auto-refresh every {REFRESH_INTERVAL_MS / 1000}s
          </div>
        </>
      )}

      {/* Initialization timelines (in-memory; app-startup re-captured each restart,
          daily-init reflects today). Rendered independently of the snapshot above. */}
      <Row className=" mb-4">
        <Col md={6}>
          <InitTimelinePanel
            icon={<BsPlayCircle />}
            title="App Startup"
            events={initTimeline?.appStartup}
            emptyText="No startup events captured yet."
          />
        </Col>
        <Col md={6}>
          <InitTimelinePanel
            icon={<BsCardChecklist />}
            title="Daily Initialization"
            events={initTimeline?.dailyInit}
            emptyText="No daily initialization yet today."
          />
        </Col>
      </Row>
    </div>
  );
};

export default SystemStatus;
