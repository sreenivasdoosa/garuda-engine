/**
 * Strategy Analytics Page
 * Comprehensive strategy performance analytics with metrics, charts, and detailed breakdowns
 */

import { useState, useMemo } from 'react';
import { Line, Bar, Doughnut } from 'react-chartjs-2';
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
import { BsLightning, BsGraphUp, BsCalendar3, BsCurrencyRupee, BsPercent, BsTrophy, BsArrowUpCircle, BsArrowDownCircle } from 'react-icons/bs';

import { PageHeader, StatCard } from '@/components/common';
import { analyticsService } from '@/services/admin/analyticsService';
import { formatCurrency, formatNumber } from '@/utils/formatters';
import { currencyChartOptions } from '@/utils/chartOptions';
import { useChartTheme } from '@/hooks/useChartTheme';
import { Badge, Spinner, ProgressBar } from '@/components/ui';
import type { Tone } from '@/components/ui';
import { productBadgeTone } from '@/types/product';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler);

const info = 'rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink';
const card = 'rounded-card border border-hairline bg-card';
const cardHead = 'border-b border-hairline px-4 py-3 text-sm font-semibold text-ink';
const cell = 'px-2 py-1.5';
const ctrl = 'h-8 rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';
const thRow = 'bg-raised text-xs uppercase text-ink-faint';

const pnlTone = (pnl: number): Tone => (pnl >= 0 ? 'success' : 'danger');
const sharpeTone = (s: number): Tone => (s >= 1 ? 'success' : s >= 0 ? 'warning' : 'danger');

const StrategyAnalytics: React.FC = () => {
  const getDefaultDates = () => {
    const today = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(today.getMonth() - 6);
    return { fromDate: sixMonthsAgo.toISOString().split('T')[0], toDate: today.toISOString().split('T')[0] };
  };

  const defaultDates = getDefaultDates();
  const [dateRange, setDateRange] = useState(defaultDates);
  const [mode, setMode] = useState<'live' | 'paper' | 'mixed'>('live');
  const [selectedStrategy, setSelectedStrategy] = useState<string>('');
  const theme = useChartTheme();

  const { data: performanceStats, isLoading: loadingStats } = useQuery({
    queryKey: ['analytics', 'strategyPerformance', dateRange, mode],
    queryFn: () => analyticsService.getStrategyPerformanceStats(dateRange.fromDate, dateRange.toDate, mode),
  });
  const { data: detailedPerformance, isLoading: loadingDetailed } = useQuery({
    queryKey: ['analytics', 'strategyDetailedPerformance', dateRange, mode],
    queryFn: () => analyticsService.getStrategyDetailedPerformance(dateRange.fromDate, dateRange.toDate, mode),
  });
  const { data: productPerformance, isLoading: loadingProduct } = useQuery({
    queryKey: ['analytics', 'productPerformance', dateRange, mode],
    queryFn: () => analyticsService.getPerformanceByProduct(dateRange.fromDate, dateRange.toDate, mode),
  });
  const { data: cumulativePnl, isLoading: loadingCumulative } = useQuery({
    queryKey: ['analytics', 'cumulativePnl', dateRange, mode],
    queryFn: () => analyticsService.getCumulativePnl(dateRange.fromDate, dateRange.toDate, mode),
  });
  const { data: monthlyPerformance, isLoading: loadingMonthly } = useQuery({
    queryKey: ['analytics', 'monthlyPerformance', dateRange, mode],
    queryFn: () => analyticsService.getMonthlyStrategyPerformance(dateRange.fromDate, dateRange.toDate, mode),
  });
  const { data: strategyDailyPnl, isLoading: loadingDaily } = useQuery({
    queryKey: ['analytics', 'strategyDailyPnl', selectedStrategy, dateRange, mode],
    queryFn: () => analyticsService.getStrategyDailyPnl(selectedStrategy, dateRange.fromDate, dateRange.toDate, mode),
    enabled: !!selectedStrategy,
  });

  const isLoading = loadingStats || loadingDetailed || loadingProduct;

  const strategyOptions = useMemo(() => {
    if (!detailedPerformance) return [];
    return detailedPerformance.map((s) => ({ value: s.strategyName, label: s.displayName || s.strategyName }));
  }, [detailedPerformance]);

  const cumulativePnlChartData = useMemo(() => {
    if (!cumulativePnl || cumulativePnl.length === 0) return null;
    const strategies = [...new Set(cumulativePnl.map((c) => c.strategyName))];
    const dates = [...new Set(cumulativePnl.map((c) => c.date))].sort();
    const colors = ['rgb(75, 192, 192)', 'rgb(255, 99, 132)', 'rgb(54, 162, 235)', 'rgb(255, 206, 86)', 'rgb(153, 102, 255)', 'rgb(255, 159, 64)', 'rgb(199, 199, 199)', 'rgb(83, 102, 255)'];
    const datasets = strategies.slice(0, 8).map((strategy, index) => {
      const strategyData = cumulativePnl.filter((c) => c.strategyName === strategy);
      return {
        label: strategy,
        data: dates.map((date) => {
          const point = strategyData.find((d) => d.date === date);
          return point ? point.cumulativePnl : null;
        }),
        borderColor: colors[index % colors.length],
        backgroundColor: colors[index % colors.length].replace('rgb', 'rgba').replace(')', ', 0.1)'),
        fill: false,
        tension: 0.4,
        spanGaps: true,
      };
    });
    return { labels: dates, datasets };
  }, [cumulativePnl]);

  const monthlyChartData = useMemo(() => {
    if (!monthlyPerformance || monthlyPerformance.length === 0) return null;
    const monthlyTotals = monthlyPerformance.reduce((acc, m) => {
      if (!acc[m.month]) acc[m.month] = { netPnl: 0, avgCapital: 0 };
      acc[m.month].netPnl += m.netPnl;
      acc[m.month].avgCapital += m.avgCapital;
      return acc;
    }, {} as Record<string, { netPnl: number; avgCapital: number }>);
    const months = Object.keys(monthlyTotals).sort();
    const pnlData = months.map((m) => monthlyTotals[m].netPnl);
    return {
      labels: months,
      datasets: [{ label: 'Monthly Net P&L', data: pnlData, backgroundColor: pnlData.map((v) => (v >= 0 ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)')), borderColor: pnlData.map((v) => (v >= 0 ? 'rgb(40, 167, 69)' : 'rgb(220, 53, 69)')), borderWidth: 1 }],
    };
  }, [monthlyPerformance]);

  const productChartData = useMemo(() => {
    if (!productPerformance || productPerformance.length === 0) return null;
    return {
      labels: productPerformance.map((p) => p.product || 'Unknown'),
      datasets: [{ data: productPerformance.map((p) => Math.abs(p.netPnl)), backgroundColor: ['rgba(54, 162, 235, 0.8)', 'rgba(255, 206, 86, 0.8)', 'rgba(75, 192, 192, 0.8)', 'rgba(153, 102, 255, 0.8)'] }],
    };
  }, [productPerformance]);

  const dailyPnlChartData = useMemo(() => {
    if (!strategyDailyPnl || strategyDailyPnl.length === 0) return null;
    return {
      labels: strategyDailyPnl.map((d) => d.date),
      datasets: [{ label: 'Daily Net P&L', data: strategyDailyPnl.map((d) => d.netPnl), backgroundColor: strategyDailyPnl.map((d) => (d.netPnl >= 0 ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)')), borderWidth: 0 }],
    };
  }, [strategyDailyPnl]);

  const scales = {
    x: { grid: { color: theme.grid }, ticks: { ...currencyChartOptions.scales.x.ticks, color: theme.axisTick } },
    y: { grid: { color: theme.grid }, ticks: { ...currencyChartOptions.scales.y.ticks, color: theme.axisTick } },
  };
  const chartOptions = { ...currencyChartOptions, scales, plugins: { ...currencyChartOptions.plugins, legend: { display: true, position: 'top' as const } } };
  const barChartOptions = { ...currencyChartOptions, scales, plugins: { ...currencyChartOptions.plugins, legend: { display: false } } };

  const topStrategies = useMemo(() => {
    if (!detailedPerformance) return [];
    return [...detailedPerformance].sort((a, b) => b.netPnl - a.netPnl).slice(0, 5);
  }, [detailedPerformance]);

  const worstStrategies = useMemo(() => {
    if (!detailedPerformance) return [];
    return [...detailedPerformance].sort((a, b) => a.netPnl - b.netPnl).slice(0, 5);
  }, [detailedPerformance]);

  return (
    <div className="fade-in">
      <PageHeader
        title="Strategy Performance"
        subtitle="Comprehensive strategy performance metrics and analysis"
        icon={<BsLightning size={24} />}
        actions={
          <div className="flex items-center gap-2">
            <select className={ctrl} value={mode} onChange={(e) => setMode(e.target.value as 'live' | 'paper' | 'mixed')} title="Live, paper-trading, or combined results">
              <option value="live">Live</option>
              <option value="paper">Paper</option>
              <option value="mixed">Live + Paper</option>
            </select>
            <input type="date" className={ctrl} value={dateRange.fromDate} onChange={(e) => setDateRange({ ...dateRange, fromDate: e.target.value })} />
            <span className="text-xs text-ink-soft">to</span>
            <input type="date" className={ctrl} value={dateRange.toDate} onChange={(e) => setDateRange({ ...dateRange, toDate: e.target.value })} />
          </div>
        }
      />

      {isLoading ? (
        <div className="py-10 text-center text-primary-500">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Overall Performance Stats */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Total Strategies" value={performanceStats?.totalStrategies || 0} icon={BsLightning} iconBg="primary" />
            <StatCard title="Trading Days" value={performanceStats?.tradingDays || 0} icon={BsCalendar3} iconBg="info" />
            <StatCard title="Net P&L" value={formatCurrency(performanceStats?.netPnl || 0)} icon={BsCurrencyRupee} iconBg={performanceStats?.netPnl && performanceStats.netPnl >= 0 ? 'success' : 'danger'} />
            <StatCard title="Win Rate" value={`${formatNumber(performanceStats?.winRate || 0, 1)}%`} icon={BsTrophy} iconBg="warning" />
          </div>

          {/* Second Row of Stats */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Capital" value={formatCurrency(performanceStats?.avgCapital || 0)} icon={BsCurrencyRupee} iconBg="secondary" />
            <StatCard title="ROI" value={`${formatNumber(performanceStats?.roi || 0, 2)}%`} icon={BsPercent} iconBg={performanceStats?.roi && performanceStats.roi >= 0 ? 'success' : 'danger'} />
            <StatCard title="Sharpe Ratio" value={formatNumber(performanceStats?.sharpeRatio || 0, 2)} icon={BsGraphUp} iconBg={performanceStats?.sharpeRatio && performanceStats.sharpeRatio >= 1 ? 'success' : performanceStats?.sharpeRatio && performanceStats.sharpeRatio >= 0 ? 'warning' : 'danger'} />
            <StatCard title="Avg Daily Return" value={`${formatNumber(performanceStats?.avgDailyReturn || 0, 3)}%`} icon={BsPercent} iconBg={performanceStats?.avgDailyReturn && performanceStats.avgDailyReturn >= 0 ? 'success' : 'danger'} />
          </div>

          {/* Third Row of Stats */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Winning Days" value={performanceStats?.winningDays || 0} icon={BsArrowUpCircle} iconBg="success" />
            <StatCard title="Losing Days" value={performanceStats?.losingDays || 0} icon={BsArrowDownCircle} iconBg="danger" />
            <StatCard title="Breakeven Days" value={performanceStats?.breakevenDays || 0} icon={BsCalendar3} iconBg="secondary" />
            <StatCard title="Return Volatility" value={`${formatNumber(performanceStats?.returnStdDev || 0, 3)}%`} icon={BsGraphUp} iconBg="info" />
          </div>

          {/* Charts Row */}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className={`${card} lg:col-span-2`}>
              <div className={cardHead}>Cumulative P&L by Strategy</div>
              <div className="p-4">
                {loadingCumulative ? (
                  <div className="py-10 text-center text-primary-500">
                    <Spinner size="sm" />
                  </div>
                ) : cumulativePnlChartData ? (
                  <div className="chart-container" style={{ height: 350 }}>
                    <Line data={cumulativePnlChartData} options={chartOptions} />
                  </div>
                ) : (
                  <div className={info}>No cumulative P&L data available</div>
                )}
              </div>
            </div>

            <div className={card}>
              <div className={cardHead}>Performance by Product Type</div>
              <div className="flex flex-col p-4">
                {loadingProduct ? (
                  <div className="py-10 text-center text-primary-500">
                    <Spinner size="sm" />
                  </div>
                ) : productChartData ? (
                  <>
                    <div className="flex flex-grow items-center justify-center" style={{ minHeight: 200 }}>
                      <div style={{ width: '100%', maxWidth: 220 }}>
                        <Doughnut data={productChartData} options={{ ...chartOptions, plugins: { legend: { display: true, position: 'bottom' } } }} />
                      </div>
                    </div>
                    <table className="mt-3 w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                      <thead className={thRow}>
                        <tr>
                          <th className={`${cell} text-left`}>Product</th>
                          <th className={`${cell} text-right`}>Net P&L</th>
                          <th className={`${cell} text-right`}>ROI</th>
                        </tr>
                      </thead>
                      <tbody>
                        {productPerformance?.map((p) => (
                          <tr key={p.product}>
                            <td className={cell}>
                              <Badge tone={productBadgeTone(p.product)}>{p.product || 'Unknown'}</Badge>
                            </td>
                            <td className={`${cell} text-right ${p.netPnl >= 0 ? 'text-success-500' : 'text-danger-500'}`}>{formatCurrency(p.netPnl)}</td>
                            <td className={`${cell} text-right`}>
                              <Badge tone={pnlTone(p.roi)}>{formatNumber(p.roi, 2)}%</Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <div className={info}>No product performance data</div>
                )}
              </div>
            </div>
          </div>

          {/* Monthly Performance Chart */}
          <div className="mb-4">
            <div className={card}>
              <div className={cardHead}>Monthly P&L Summary</div>
              <div className="p-4">
                {loadingMonthly ? (
                  <div className="py-10 text-center text-primary-500">
                    <Spinner size="sm" />
                  </div>
                ) : monthlyChartData ? (
                  <div className="chart-container" style={{ height: 300 }}>
                    <Bar data={monthlyChartData} options={barChartOptions} />
                  </div>
                ) : (
                  <div className={info}>No monthly performance data available</div>
                )}
              </div>
            </div>
          </div>

          {/* Top & Worst Performers */}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {[
              { title: 'Top Performing Strategies', icon: <BsArrowUpCircle />, rows: topStrategies, headCls: 'bg-success-500 text-white', pnlCls: 'text-success-500', roiTone: 'success' as Tone },
              { title: 'Worst Performing Strategies', icon: <BsArrowDownCircle />, rows: worstStrategies, headCls: 'bg-danger-500 text-white', pnlCls: 'text-danger-500', roiTone: 'danger' as Tone },
            ].map((blk) => (
              <div key={blk.title} className={card}>
                <div className={`flex items-center gap-2 rounded-t-card px-4 py-3 text-sm font-semibold ${blk.headCls}`}>
                  {blk.icon}
                  {blk.title}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                    <thead className={thRow}>
                      <tr>
                        <th className={`${cell} text-left`}>Strategy</th>
                        <th className={`${cell} text-right`}>Net P&L</th>
                        <th className={`${cell} text-right`}>ROI</th>
                        <th className={`${cell} text-right`}>Sharpe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {blk.rows.map((s) => (
                        <tr key={s.strategyName} className="hover:bg-raised/50">
                          <td className={cell}>
                            <div className="text-ink">{s.displayName || s.strategyName}</div>
                            <small className="text-ink-soft">{s.product}</small>
                          </td>
                          <td className={`${cell} text-right ${blk.pnlCls}`}>{formatCurrency(s.netPnl)}</td>
                          <td className={`${cell} text-right`}>
                            <Badge tone={blk.roiTone}>{formatNumber(s.roi, 2)}%</Badge>
                          </td>
                          <td className={`${cell} text-right text-ink`}>{formatNumber(s.sharpeRatio, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>

          {/* Strategy Daily Performance */}
          <div className="mb-4">
            <div className={card}>
              <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
                <h6 className="mb-0 text-sm font-semibold text-ink">Strategy Daily P&L</h6>
                <select className={ctrl} style={{ width: 250 }} value={selectedStrategy} onChange={(e) => setSelectedStrategy(e.target.value)}>
                  <option value="">Select a strategy...</option>
                  {strategyOptions.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="p-4">
                {!selectedStrategy ? (
                  <div className={info}>Select a strategy to view daily P&L breakdown</div>
                ) : loadingDaily ? (
                  <div className="py-10 text-center text-primary-500">
                    <Spinner size="sm" />
                  </div>
                ) : dailyPnlChartData ? (
                  <div className="chart-container" style={{ height: 300 }}>
                    <Bar data={dailyPnlChartData} options={barChartOptions} />
                  </div>
                ) : (
                  <div className={info}>No daily P&L data for selected strategy</div>
                )}
              </div>
            </div>
          </div>

          {/* Detailed Strategy Performance Table */}
          <div className="mb-4">
            <div className={card}>
              <div className={`${cardHead} flex items-center gap-2`}>
                <BsGraphUp /> Detailed Strategy Performance
              </div>
              <div>
                {loadingDetailed ? (
                  <div className="py-10 text-center text-primary-500">
                    <Spinner size="sm" />
                  </div>
                ) : detailedPerformance && detailedPerformance.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                      <thead className={thRow}>
                        <tr>
                          <th className={`${cell} text-left`}>Strategy</th>
                          <th className={`${cell} text-left`}>Product</th>
                          <th className={`${cell} text-right`}>Days</th>
                          <th className={`${cell} text-right`}>Capital</th>
                          <th className={`${cell} text-right`}>Gross P&L</th>
                          <th className={`${cell} text-right`}>Charges</th>
                          <th className={`${cell} text-right`}>Net P&L</th>
                          <th className={`${cell} text-right`}>ROI</th>
                          <th className={`${cell} text-right`}>Max Profit</th>
                          <th className={`${cell} text-right`}>Max Loss</th>
                          <th className={`${cell} text-right`}>Avg Daily</th>
                          <th className={`${cell} text-right`}>Sharpe</th>
                          <th className={`${cell} text-right`}>Users</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailedPerformance.map((s) => (
                          <tr key={s.strategyName} className="hover:bg-raised/50">
                            <td className={cell}>
                              <div className="font-medium text-ink">{s.displayName || s.strategyName}</div>
                            </td>
                            <td className={cell}>
                              <Badge tone={productBadgeTone(s.product)}>{s.product}</Badge>
                            </td>
                            <td className={`${cell} text-right text-ink`}>{s.tradingDays}</td>
                            <td className={`${cell} text-right text-ink`}>{formatCurrency(s.avgCapital)}</td>
                            <td className={`${cell} text-right ${s.grossPnl >= 0 ? 'text-success-500' : 'text-danger-500'}`}>{formatCurrency(s.grossPnl)}</td>
                            <td className={`${cell} text-right text-ink-soft`}>{formatCurrency(s.totalCharges)}</td>
                            <td className={`${cell} text-right`}>
                              <Badge tone={pnlTone(s.netPnl)}>{formatCurrency(s.netPnl)}</Badge>
                            </td>
                            <td className={`${cell} text-right`}>
                              <Badge tone={pnlTone(s.roi)}>{formatNumber(s.roi, 2)}%</Badge>
                            </td>
                            <td className={`${cell} text-right text-success-500`}>{formatCurrency(s.maxDailyProfit)}</td>
                            <td className={`${cell} text-right text-danger-500`}>{formatCurrency(s.maxDailyLoss)}</td>
                            <td className={`${cell} text-right text-ink`}>{formatCurrency(s.avgDailyPnl)}</td>
                            <td className={`${cell} text-right`}>
                              <Badge tone={sharpeTone(s.sharpeRatio)}>{formatNumber(s.sharpeRatio, 2)}</Badge>
                            </td>
                            <td className={`${cell} text-right text-ink`}>{s.uniqueUsers}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className={info + ' m-3'}>No strategy performance data available</div>
                )}
              </div>
            </div>
          </div>

          {/* Performance Summary */}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className={card}>
              <div className={cardHead}>Performance Summary</div>
              <div className="p-4">
                <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                  <tbody>
                    <tr>
                      <td className={`${cell} text-ink`}>Total Gross P&L</td>
                      <td className={`${cell} text-right font-bold ${performanceStats?.grossPnl && performanceStats.grossPnl >= 0 ? 'text-success-500' : 'text-danger-500'}`}>{formatCurrency(performanceStats?.grossPnl || 0)}</td>
                    </tr>
                    <tr>
                      <td className={`${cell} text-ink`}>Total Charges</td>
                      <td className={`${cell} text-right text-ink-soft`}>{formatCurrency(performanceStats?.totalCharges || 0)}</td>
                    </tr>
                    <tr>
                      <td className={`${cell} text-ink`}>Net P&L</td>
                      <td className={`${cell} text-right`}>
                        <Badge tone={pnlTone(performanceStats?.netPnl || 0)}>{formatCurrency(performanceStats?.netPnl || 0)}</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className={`${cell} text-ink`}>Return on Investment (ROI)</td>
                      <td className={`${cell} text-right`}>
                        <Badge tone={pnlTone(performanceStats?.roi || 0)}>{formatNumber(performanceStats?.roi || 0, 2)}%</Badge>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div className={card}>
              <div className={cardHead}>Day-wise Statistics</div>
              <div className="p-4">
                <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                  <tbody>
                    <tr>
                      <td className={`${cell} text-ink`}>Total Trading Days</td>
                      <td className={`${cell} text-right font-bold text-ink`}>{performanceStats?.tradingDays || 0}</td>
                    </tr>
                    <tr>
                      <td className={`${cell} text-ink`}>Winning Days</td>
                      <td className={`${cell} text-right`}>
                        <Badge tone="success">{performanceStats?.winningDays || 0}</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className={`${cell} text-ink`}>Losing Days</td>
                      <td className={`${cell} text-right`}>
                        <Badge tone="danger">{performanceStats?.losingDays || 0}</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className={`${cell} text-ink`}>Breakeven Days</td>
                      <td className={`${cell} text-right`}>
                        <Badge tone="neutral">{performanceStats?.breakevenDays || 0}</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className={`${cell} text-ink`}>Win Rate</td>
                      <td className={`${cell} text-right`}>
                        <div className="flex items-center justify-end gap-2">
                          <ProgressBar value={performanceStats?.winRate || 0} tone={performanceStats?.winRate && performanceStats.winRate >= 50 ? 'success' : 'warning'} className="w-24" height="h-2" />
                          <span className="font-bold text-ink">{formatNumber(performanceStats?.winRate || 0, 1)}%</span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default StrategyAnalytics;
