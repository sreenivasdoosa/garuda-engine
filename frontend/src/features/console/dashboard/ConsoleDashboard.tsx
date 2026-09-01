import { useState, useMemo } from 'react';
import { Row, Col, Card, Table, Badge, Spinner, Alert, ProgressBar, ButtonGroup, ToggleButton, Dropdown, Form } from '@/components/ui/rbShim';
import {
  BsPeople,
  BsLightning,
  BsBank,
  BsGraphUp,
  BsGraphDown,
  BsCheckCircle,
  BsXCircle,
  BsReceipt,
  BsExclamationTriangle,
  BsPersonCheck,
} from 'react-icons/bs';
import { Line, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { PageHeader, StatCard } from '@/components/common';
import { analyticsService } from '@/services/admin/analyticsService';
import { brokerLoginStatusService } from '@/services/admin/v2AdminService';
import { formatIndianNumber } from '@/utils/formatters';
import { countChartOptions, currencyChartOptions } from '@/utils/chartOptions';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const isUpdatedToday = (updatedOn?: number) => {
  if (!updatedOn) return false;
  const today = new Date();
  const updated = new Date(updatedOn);
  return updated.toDateString() === today.toDateString();
};

type DateMode = 'week' | 'month' | 'quarter' | 'fy' | 'allTime' | 'custom';

// Earliest FY year shown in the FY dropdown. Older = use "All Time".
const MIN_FY_START_YEAR = 2022;
// Lower bound used by the "All Time" range. Cheap arbitrary cutoff that
// covers any plausible historical data without requiring a min(date) lookup.
const ALL_TIME_FROM_DATE = '2000-01-01';

// Format Date as YYYY-MM-DD without UTC drift.
const fmt = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const currentFyStartYear = (today: Date) =>
  today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;

const fyLabelFor = (startYear: number) => {
  const endYY = (startYear + 1) % 100;
  return `FY ${startYear}-${String(endYY).padStart(2, '0')}`;
};

// All FY start years to show in the dropdown — newest first.
const fyStartYearsList = (today: Date): number[] => {
  const cur = currentFyStartYear(today);
  const out: number[] = [];
  for (let y = cur; y >= MIN_FY_START_YEAR; y--) out.push(y);
  return out;
};

// Compute the [from, to] for a non-FY/non-custom mode. End = today.
const rangeForPreset = (mode: 'week' | 'month' | 'quarter', today: Date) => {
  let start: Date;
  switch (mode) {
    case 'week': {
      // Week starts Monday. JS getDay: Sun=0, Mon=1, ... Sat=6.
      start = new Date(today);
      const dow = start.getDay();
      const offset = dow === 0 ? 6 : dow - 1;
      start.setDate(start.getDate() - offset);
      break;
    }
    case 'month':
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      break;
    case 'quarter': {
      const qStartMonth = Math.floor(today.getMonth() / 3) * 3;
      start = new Date(today.getFullYear(), qStartMonth, 1);
      break;
    }
  }
  return { fromDate: fmt(start), toDate: fmt(today) };
};

const ConsoleDashboard: React.FC = () => {
  // Per-resource permission flags. Sysadmins get true for everything via
  // the hook's hasRight() short-circuit. Each widget below is rendered only
  // when the corresponding flag is true; the matching React-Query call also
  // uses { enabled: <flag> } so unauthorized users don't trigger a 403.
  //
  // Resource map (matches AnalyticsServletV2.getResourceForPath):
  //   /users, /users/growth        → USER_ANALYTICS    (analyticsUsers)
  //   /strategies, /brokers, /trades/eod-summary → TRADE_ANALYTICS (analyticsTrades)
  //   /capital                     → CAPITAL_ANALYTICS (analyticsCapital)
  //   /billing, /billing/revenue   → BILLING_ANALYTICS (analyticsBilling)
  //   /user-broker-login-status    → USER_BROKERS      (userBrokers)

  // Quick Links target admin pages, so each link is gated by its OWN page permission
  // (not the analytics permissions above) — a link is shown only if the user can view that page.
  // "Manage Strategies" points at the Strategy Engine page → gate by the same permission the sidebar
  // uses for it (strategyEngine), so link visibility, the route, and the page stay consistent.
  // Strategy catalog stats (Strategies tile + Strategy Summary) are strategy-engine data, so they
  // are gated by the strategy-engine permission — NOT trade analytics (QUANT-188).
  const canViewAnyQuickLink =
    true || true || true || true;

  // Single date range applied to ALL date-filtered tiles + charts.
  const today = useMemo(() => new Date(), []);
  const [mode, setMode] = useState<DateMode>('quarter');
  const [fyStartYear, setFyStartYear] = useState<number>(() => currentFyStartYear(today));
  const initialCustom = useMemo(() => rangeForPreset('quarter', today), [today]);
  const [customFromDate, setCustomFromDate] = useState<string>(initialCustom.fromDate);
  const [customToDate, setCustomToDate] = useState<string>(initialCustom.toDate);

  const range = useMemo(() => {
    switch (mode) {
      case 'week':
      case 'month':
      case 'quarter':
        return rangeForPreset(mode, today);
      case 'fy': {
        // Indian FY runs Apr 1 of fyStartYear → Mar 31 of fyStartYear+1.
        // For the *current* FY, cap at today (FY hasn't closed yet).
        // For past FYs, use the FY-end date (Mar 31) so the date filter
        // is properly bounded — using today here would over-include any
        // post-FY rows like a backfill bill landing later.
        const isCurrent = fyStartYear === currentFyStartYear(today);
        const fyEnd = `${fyStartYear + 1}-03-31`;
        return {
          fromDate: `${fyStartYear}-04-01`,
          toDate: isCurrent ? fmt(today) : fyEnd,
        };
      }
      case 'allTime':
        return { fromDate: ALL_TIME_FROM_DATE, toDate: fmt(today) };
      case 'custom':
        return { fromDate: customFromDate, toDate: customToDate };
    }
  }, [mode, fyStartYear, customFromDate, customToDate, today]);

  const fyYears = useMemo(() => fyStartYearsList(today), [today]);
  const fyButtonLabel = useMemo(() => {
    if (mode === 'allTime') return 'All Time';
    if (mode === 'fy') {
      return fyStartYear === currentFyStartYear(today)
        ? `This ${fyLabelFor(fyStartYear)}`
        : fyLabelFor(fyStartYear);
    }
    return fyLabelFor(currentFyStartYear(today));
  }, [mode, fyStartYear, today]);

  // Fetch user stats
  const { data: userStats, isLoading: loadingUsers } = useQuery({
    queryKey: ['dashboard', 'users'],
    queryFn: () => analyticsService.getUserStats(),
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: true,
  });

  // User growth honors the selected range too.
  const { data: userGrowth, isLoading: loadingGrowth } = useQuery({
    queryKey: ['dashboard', 'userGrowth', range],
    queryFn: () => analyticsService.getUserGrowth(range.fromDate, range.toDate),
    staleTime: 5 * 60 * 1000,
    enabled: true,
  });

  // Fetch broker stats
  const { data: brokerStats, isLoading: loadingBrokers } = useQuery({
    queryKey: ['dashboard', 'brokers'],
    queryFn: () => analyticsService.getBrokerStats(),
    staleTime: 5 * 60 * 1000,
    enabled: true,
  });

  const { data: brokerLoginStatuses } = useQuery({
    queryKey: ['dashboard', 'brokerLoginStatuses'],
    queryFn: () => brokerLoginStatusService.getStatus(),
    staleTime: 60 * 1000,
    enabled: true,
  });

  // Fetch strategy stats
  const { data: strategyStats, isLoading: loadingStrategies } = useQuery({
    queryKey: ['dashboard', 'strategies'],
    queryFn: () => analyticsService.getStrategyStats(),
    staleTime: 5 * 60 * 1000,
    enabled: true,
  });

  // Fast EOD-based trade summary (replaces the previous full-table scan
  // against TRADES_INTRADAY/POSITIONAL). Same date range as everything else.
  const { data: tradeSummary, isLoading: loadingTrades } = useQuery({
    queryKey: ['dashboard', 'tradesEod', range],
    queryFn: () => analyticsService.getEodTradeSummary(range.fromDate, range.toDate),
    staleTime: 5 * 60 * 1000,
    enabled: true,
  });

  // Billing/revenue/capital all share the selected range.
  const { data: billingSummary, isLoading: loadingBilling } = useQuery({
    queryKey: ['dashboard', 'billing', range],
    queryFn: () => analyticsService.getBillingSummary(range.fromDate, range.toDate),
    staleTime: 5 * 60 * 1000,
    enabled: true,
  });

  const { data: capitalData, isLoading: loadingCapital } = useQuery({
    queryKey: ['dashboard', 'capital', range],
    queryFn: () => analyticsService.getDailyCapitalSummary(range.fromDate, range.toDate),
    staleTime: 5 * 60 * 1000,
    enabled: true,
  });

  // Same range as every other tile/chart on the dashboard. Mid-quarter
  // / mid-week views may legitimately read ₹0 because bills land at
  // quarter-end — that's accurate, not a bug.
  // Day-level win rate (% of trading days that were net-profitable across
  // all users/strategies in the selected range).
  const winRate = useMemo(() => {
    if (!tradeSummary) return 0;
    const total = tradeSummary.winningDays + tradeSummary.losingDays;
    if (total === 0) return 0;
    return Math.round((tradeSummary.winningDays / total) * 100);
  }, [tradeSummary]);

  const selectedRangeLabel = useMemo(() => {
    switch (mode) {
      case 'week': return 'This Week';
      case 'month': return 'This Month';
      case 'quarter': return 'This Quarter';
      case 'fy':
        return fyStartYear === currentFyStartYear(today)
          ? `This ${fyLabelFor(fyStartYear)}`
          : fyLabelFor(fyStartYear);
      case 'allTime': return 'All Time';
      case 'custom': return `${customFromDate} → ${customToDate}`;
    }
  }, [mode, fyStartYear, customFromDate, customToDate, today]);

  const failedLoginsToday = useMemo(() => {
    if (!brokerLoginStatuses) return 0;
    return brokerLoginStatuses.filter((status) => !status.isLoginSuccess && isUpdatedToday(status.updatedOn)).length;
  }, [brokerLoginStatuses]);

  // Chart configurations - Compact
  // chart options imported from shared util (countChartOptions /
  // currencyChartOptions). User Growth = counts; Revenue + Capital =
  // currency. Local alias for backwards-compat with the existing JSX.
  const chartOptions = countChartOptions;

  // User Growth Chart Data
  const userGrowthChartData = {
    labels: userGrowth?.map((d) => d.label) || [],
    datasets: [
      {
        label: 'Users',
        data: userGrowth?.map((d) => d.value) || [],
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: 'rgba(75, 192, 192, 0.1)',
        tension: 0.4,
        fill: true,
        borderWidth: 1.5,
        pointRadius: 2,
      },
    ],
  };

  // Broker Distribution Chart Data
  const brokerDistributionData = {
    labels: brokerStats?.brokerDistribution?.map((d) => d.name) || [],
    datasets: [
      {
        data: brokerStats?.brokerDistribution?.map((d) => d.count) || [],
        backgroundColor: [
          'rgba(45, 206, 137, 0.8)',
          'rgba(17, 205, 239, 0.8)',
          'rgba(251, 99, 64, 0.8)',
          'rgba(94, 114, 228, 0.8)',
          'rgba(136, 152, 170, 0.8)',
          'rgba(255, 193, 7, 0.8)',
        ],
      },
    ],
  };

  // Capital Trend Chart Data
  const capitalTrendData = {
    labels: capitalData?.map((d) => d.date) || [],
    datasets: [
      {
        label: 'Total Capital',
        data: capitalData?.map((d) => d.totalCapital) || [],
        borderColor: 'rgb(94, 114, 228)',
        backgroundColor: 'rgba(94, 114, 228, 0.1)',
        tension: 0.4,
        fill: true,
        borderWidth: 1.5,
        pointRadius: 2,
      },
    ],
  };

  return (
    <div className="fade-in">
      <PageHeader
        title="Console Dashboard"
        subtitle="Every account this engine trades, and how the day is going"
        actions={
          <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: '0.7rem' }}>
            <ButtonGroup size="sm">
              {(['week', 'month', 'quarter'] as const).map((m) => (
                <ToggleButton
                  key={m}
                  id={`range-${m}`}
                  type="radio"
                  variant={mode === m ? 'primary' : 'outline-primary'}
                  name="range"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
                >
                  {m === 'week' ? 'This Week' : m === 'month' ? 'This Month' : 'This Quarter'}
                </ToggleButton>
              ))}
            </ButtonGroup>

            {/* FY dropdown — current FY + previous FYs (down to MIN_FY_START_YEAR) + All Time */}
            <Dropdown>
              <Dropdown.Toggle
                size="sm"
                variant={mode === 'fy' || mode === 'allTime' ? 'primary' : 'outline-primary'}
                style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
              >
                {fyButtonLabel}
              </Dropdown.Toggle>
              <Dropdown.Menu style={{ fontSize: '0.75rem' }}>
                {fyYears.map((y) => (
                  <Dropdown.Item
                    key={y}
                    active={mode === 'fy' && fyStartYear === y}
                    onClick={() => {
                      setMode('fy');
                      setFyStartYear(y);
                    }}
                  >
                    {y === currentFyStartYear(today) ? `This ${fyLabelFor(y)}` : fyLabelFor(y)}
                  </Dropdown.Item>
                ))}
                <Dropdown.Divider />
                <Dropdown.Item active={mode === 'allTime'} onClick={() => setMode('allTime')}>
                  All Time
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown>

            <ButtonGroup size="sm">
              <ToggleButton
                id="range-custom"
                type="radio"
                variant={mode === 'custom' ? 'primary' : 'outline-primary'}
                name="range"
                value="custom"
                checked={mode === 'custom'}
                onChange={() => setMode('custom')}
                style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
              >
                Custom
              </ToggleButton>
            </ButtonGroup>

            {mode === 'custom' && (
              <>
                <Form.Control
                  type="date"
                  size="sm"
                  value={customFromDate}
                  max={customToDate}
                  onChange={(e) => setCustomFromDate(e.target.value)}
                  style={{ width: '140px', fontSize: '0.7rem' }}
                />
                <Form.Control
                  type="date"
                  size="sm"
                  value={customToDate}
                  min={customFromDate}
                  onChange={(e) => setCustomToDate(e.target.value)}
                  style={{ width: '140px', fontSize: '0.7rem' }}
                />
              </>
            )}
          </div>
        }
      />

      {/* Main Stats Row — each tile gated by its analytics resource */}
      <Row className="mb-4">
                  <Col sm={6} lg={3} className="mb-2 lg:mb-0">
            <StatCard
              title="Trading Clients"
              value={`${userStats?.activeUsers || 0} / ${userStats?.totalUsers || 0}`}
              subtitle="Trading / Total"
              icon={BsPeople}
              iconBg="primary"
              loading={loadingUsers}
            />
          </Col>
        
                  <Col sm={6} lg={3} className="mb-2 lg:mb-0">
            <StatCard
              title="Strategies"
              value={`${strategyStats?.activeStrategies || 0} / ${strategyStats?.totalStrategies || 0}`}
              subtitle="Active / Total"
              icon={BsLightning}
              iconBg="success"
              loading={loadingStrategies}
            />
          </Col>
        
                  <Col sm={6} lg={3} className="mb-2 lg:mb-0">
            <StatCard
              title="Broker Sessions"
              value={`${brokerStats?.enabledMappings || 0} / ${brokerStats?.totalMappings || 0}`}
              subtitle="Logged in / Total"
              icon={BsBank}
              iconBg="info"
              loading={loadingBrokers}
            />
          </Col>
        
      </Row>

      {/* Trade Performance Row — entire row gated by TRADE_ANALYTICS */}
              <Row className="mb-4">
          <Col sm={6} lg={3} className="mb-2 lg:mb-0">
            <StatCard
              title={`Trading Days (${selectedRangeLabel})`}
              value={tradeSummary?.tradingDays || 0}
              icon={BsGraphUp}
              iconBg="primary"
              loading={loadingTrades}
            />
          </Col>
          <Col sm={6} lg={3} className="mb-2 lg:mb-0">
            <StatCard
              title={`Net P&L (${selectedRangeLabel})`}
              value={tradeSummary?.totalNetPnl || 0}
              prefix="₹"
              icon={tradeSummary?.totalNetPnl && tradeSummary.totalNetPnl >= 0 ? BsGraphUp : BsGraphDown}
              iconBg={tradeSummary?.totalNetPnl && tradeSummary.totalNetPnl >= 0 ? 'success' : 'danger'}
              loading={loadingTrades}
            />
          </Col>
          <Col sm={6} lg={3} className="mb-2 lg:mb-0">
            <StatCard
              title="Win Rate (Day-level)"
              value={winRate}
              suffix="%"
              icon={winRate >= 50 ? BsCheckCircle : BsXCircle}
              iconBg={winRate >= 50 ? 'success' : 'warning'}
              loading={loadingTrades}
            />
          </Col>
          <Col sm={6} lg={3}>
            <StatCard
              title="Active Positional Trades"
              value={tradeSummary?.activePositionalTrades || 0}
              icon={BsPersonCheck}
              iconBg="info"
              loading={loadingTrades}
            />
          </Col>
        </Row>
      

      {/* Charts Row 1 — User Growth gated by USER_ANALYTICS; Quick Links shown only when the user
          can view at least one linked admin page (each link is gated by its own page permission).
          When User Growth is hidden, Quick Links expands to full width. */}
      <Row className="mb-4">
                  <Col lg={8} className="mb-4 lg:mb-0">
            <Card className="h-full">
              <Card.Header className="flex justify-between items-center py-2">
                <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>User Growth ({selectedRangeLabel})</span>
                <Link to="/console/analytics/users" className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 bg-transparent text-primary-600 hover:underline dark:text-primary-400 px-2.5 py-1 text-xs" style={{ fontSize: '0.7rem', padding: 0 }}>
                  View Details
                </Link>
              </Card.Header>
              <Card.Body className="p-2">
                {loadingGrowth ? (
                  <div className="text-center py-6">
                    <Spinner size="sm" />
                  </div>
                ) : userGrowth && userGrowth.length > 0 ? (
                  <div style={{ height: '180px' }}>
                    <Line data={userGrowthChartData} options={chartOptions} />
                  </div>
                ) : (
                  <Alert variant="info" className="mb-0" style={{ fontSize: '0.75rem' }}>No user growth data available</Alert>
                )}
              </Card.Body>
            </Card>
          </Col>
        

        {canViewAnyQuickLink && (
        <Col lg={4}>
          <Card className="h-full">
            <Card.Header className="py-2">
              <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Quick Links</span>
            </Card.Header>
            <Card.Body className="p-2">
              <div className="grid gap-1">
                                  <Link to="/console/users" className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10 px-2.5 py-1 text-xs" style={{ fontSize: '0.7rem' }}>
                    Manage Users
                  </Link>
                
                                  <Link to="/console/strategy-engine" className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10 px-2.5 py-1 text-xs" style={{ fontSize: '0.7rem' }}>
                    Manage Strategies
                  </Link>
                
                                  <Link to="/console/brokers" className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10 px-2.5 py-1 text-xs" style={{ fontSize: '0.7rem' }}>
                    Manage Brokers
                  </Link>
                
                                  <Link to="/console/audit-logs" className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 border border-primary-600 text-primary-700 dark:border-primary-500 dark:text-primary-400 hover:bg-primary-500/10 px-2.5 py-1 text-xs" style={{ fontSize: '0.7rem' }}>
                    Audit Logs
                  </Link>
                
              </div>
            </Card.Body>
          </Card>
        </Col>
        )}
      </Row>

      {/* Charts Row 2 — Revenue (BILLING_ANALYTICS) + Capital
          (CAPITAL_ANALYTICS). When only one is visible it fills the row. */}
      {(true || true) && (
        <Row className="mb-4">
          

                      <Col lg={6}>
              <Card className="h-full">
                <Card.Header className="flex justify-between items-center py-2">
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Capital Trend ({selectedRangeLabel})</span>
                  <Link to="/console/analytics/capital" className="inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 bg-transparent text-primary-600 hover:underline dark:text-primary-400 px-2.5 py-1 text-xs" style={{ fontSize: '0.7rem', padding: 0 }}>
                    View Details
                  </Link>
                </Card.Header>
                <Card.Body className="p-2">
                  {loadingCapital ? (
                    <div className="text-center py-6">
                      <Spinner size="sm" />
                    </div>
                  ) : capitalData && capitalData.length > 0 ? (
                    <div style={{ height: '180px' }}>
                      <Line data={capitalTrendData} options={currencyChartOptions} />
                    </div>
                  ) : (
                    <Alert variant="info" className="mb-0" style={{ fontSize: '0.75rem' }}>No capital data available</Alert>
                  )}
                </Card.Body>
              </Card>
            </Col>
          
        </Row>
      )}

      {/* Summary Cards Row — Billing (BILLING_ANALYTICS), Broker Distribution (TRADE_ANALYTICS),
          Strategy Summary (STRATEGY_ENGINE). */}
      {(true || true || true) && (
      <Row className="mb-4">
        {/* Billing Summary */}
                <Col lg={4} className="mb-4 lg:mb-0">
          <Card className="h-full">
            <Card.Header className="flex justify-between items-center py-2">
              <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                <BsReceipt className="me-1" size={12} />
                Billing Summary ({selectedRangeLabel})
              </span>
            </Card.Header>
            <Card.Body className="p-2">
              {loadingBilling ? (
                <div className="text-center py-4">
                  <Spinner size="sm" />
                </div>
              ) : billingSummary ? (
                <Table size="sm" className="mb-0" style={{ fontSize: '0.7rem' }}>
                  <tbody>
                    <tr>
                      <td className="py-1">Total Bills</td>
                      <td className="text-end font-bold py-1">{billingSummary.totalBills}</td>
                    </tr>
                    <tr>
                      <td className="py-1">Paid Bills</td>
                      <td className="text-end py-1">
                        <Badge bg="success" style={{ fontSize: '0.6rem' }}>{billingSummary.paidBills}</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1">Pending Bills</td>
                      <td className="text-end py-1">
                        <Badge bg="warning" style={{ fontSize: '0.6rem' }}>{billingSummary.pendingBills}</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1">Overdue Bills</td>
                      <td className="text-end py-1">
                        <Badge bg="danger" style={{ fontSize: '0.6rem' }}>{billingSummary.overdueBills}</Badge>
                      </td>
                    </tr>
                    <tr className="border-t">
                      <td className="py-1">Total Billed</td>
                      <td className="text-end font-bold py-1">₹{formatIndianNumber(billingSummary.totalBilled)}</td>
                    </tr>
                    <tr>
                      <td className="py-1">Total Paid</td>
                      <td className="text-end text-success-500 dark:text-success-400 py-1">₹{formatIndianNumber(billingSummary.totalPaid)}</td>
                    </tr>
                    <tr>
                      <td className="py-1">Outstanding</td>
                      <td className="text-end text-danger-600 dark:text-danger-400 py-1">₹{formatIndianNumber(billingSummary.outstanding)}</td>
                    </tr>
                  </tbody>
                </Table>
              ) : (
                <Alert variant="info" className="mb-0" style={{ fontSize: '0.75rem' }}>No billing data available</Alert>
              )}
            </Card.Body>
          </Card>
        </Col>
        

        {/* Broker Distribution */}
                <Col lg={4} className="mb-4 lg:mb-0">
          <Card className="h-full">
            <Card.Header className="py-2">
              <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                <BsBank className="me-1" size={12} />
                Broker Distribution
              </span>
            </Card.Header>
            <Card.Body className="flex items-center justify-center p-2">
              {loadingBrokers ? (
                <Spinner size="sm" />
              ) : brokerStats?.brokerDistribution && brokerStats.brokerDistribution.length > 0 ? (
                <div style={{ width: '100%', maxWidth: 160, height: 160 }}>
                  <Doughnut
                    data={brokerDistributionData}
                    options={{
                      ...chartOptions,
                      plugins: {
                        legend: { display: true, position: 'bottom', labels: { font: { size: 9 }, boxWidth: 8 } },
                        tooltip: {
                          bodyFont: { size: 10 },
                          titleFont: { size: 10 },
                          callbacks: {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            label: (ctx: any) => {
                              const v = typeof ctx?.parsed === 'number' ? ctx.parsed : 0;
                              const formatted = formatIndianNumber(v);
                              return ctx?.label ? `${ctx.label}: ${formatted}` : formatted;
                            },
                          },
                        },
                      },
                    }}
                  />
                </div>
              ) : (
                <Alert variant="info" className="mb-0" style={{ fontSize: '0.75rem' }}>No broker data available</Alert>
              )}
            </Card.Body>
          </Card>
        </Col>
        

        {/* Strategy Summary */}
                <Col lg={4}>
          <Card className="h-full">
            <Card.Header className="py-2">
              <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                <BsLightning className="me-1" size={12} />
                Strategy Summary
              </span>
            </Card.Header>
            <Card.Body className="p-2">
              {loadingStrategies ? (
                <div className="text-center py-4">
                  <Spinner size="sm" />
                </div>
              ) : strategyStats ? (
                <>
                  <Table size="sm" className="mb-2" style={{ fontSize: '0.7rem' }}>
                    <tbody>
                      <tr>
                        <td className="py-1">Total Strategies</td>
                        <td className="text-end font-bold py-1">{strategyStats.totalStrategies}</td>
                      </tr>
                      <tr>
                        <td className="py-1">Active</td>
                        <td className="text-end py-1">
                          <Badge bg="success" style={{ fontSize: '0.6rem' }}>{strategyStats.activeStrategies}</Badge>
                        </td>
                      </tr>
                      <tr>
                        <td className="py-1">Stopped</td>
                        <td className="text-end py-1">
                          <Badge bg="warning" style={{ fontSize: '0.6rem' }}>{strategyStats.stoppedStrategies}</Badge>
                        </td>
                      </tr>
                      <tr>
                        <td className="py-1">Disabled</td>
                        <td className="text-end py-1">
                          <Badge bg="secondary" style={{ fontSize: '0.6rem' }}>{strategyStats.disabledStrategies}</Badge>
                        </td>
                      </tr>
                    </tbody>
                  </Table>
                  <div>
                    <small className="text-ink-soft" style={{ fontSize: '0.65rem' }}>User Configs</small>
                    <ProgressBar className="mt-1" style={{ height: '12px' }}>
                      <ProgressBar
                        variant="success"
                        now={(strategyStats.enabledUserConfigs / (strategyStats.totalUserConfigs || 1)) * 100}
                        label={strategyStats.enabledUserConfigs}
                        key={1}
                        style={{ fontSize: '0.6rem' }}
                      />
                      <ProgressBar
                        variant="secondary"
                        now={((strategyStats.totalUserConfigs - strategyStats.enabledUserConfigs) / (strategyStats.totalUserConfigs || 1)) * 100}
                        label={strategyStats.totalUserConfigs - strategyStats.enabledUserConfigs}
                        key={2}
                        style={{ fontSize: '0.6rem' }}
                      />
                    </ProgressBar>
                  </div>
                </>
              ) : (
                <Alert variant="info" className="mb-0" style={{ fontSize: '0.75rem' }}>No strategy data available</Alert>
              )}
            </Card.Body>
          </Card>
        </Col>
        
      </Row>
      )}

      {/* Failed-logins alert — gated by USER_BROKERS (the source endpoint
          requires that resource). */}
      {failedLoginsToday > 0 && (
        <Alert variant="warning" className="flex items-center py-2" style={{ fontSize: '0.75rem' }}>
          <BsExclamationTriangle className="me-2" size={14} />
          <div>
            <strong>{failedLoginsToday} broker login(s) failed today.</strong>
            {' '}
            <Link to="/console/user-brokers?tab=login-status">Review affected users</Link>
          </div>
        </Alert>
      )}
    </div>
  );
};

export default ConsoleDashboard;
