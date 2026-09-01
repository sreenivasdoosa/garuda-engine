/**
 * Trade Analytics Page
 * Trade summary, P&L analysis, strategy performance
 */

import { useState } from 'react';
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
import { BsGraphUp, BsGraphDown, BsArrowUpRight, BsArrowDownRight, BsActivity, BsCheckCircle, BsXCircle } from 'react-icons/bs';

import { PageHeader, StatCard } from '@/components/common';
import { analyticsService } from '@/services/admin/analyticsService';
import { formatIndianNumber } from '@/utils/formatters';
import { currencyChartOptions } from '@/utils/chartOptions';
import { useChartTheme } from '@/hooks/useChartTheme';
import { Badge, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler);

const info = 'rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink';
const card = 'rounded-card border border-hairline bg-card';
const cardHead = 'border-b border-hairline px-4 py-3 text-sm font-semibold text-ink';
const cell = 'px-2 py-1.5';
const ctrl = 'h-8 rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';

const winTone = (rate: number): Tone => (rate >= 50 ? 'success' : 'warning');

const TradeAnalytics: React.FC = () => {
  const getDefaultDates = () => {
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);
    return { fromDate: thirtyDaysAgo.toISOString().split('T')[0], toDate: today.toISOString().split('T')[0] };
  };

  const defaultDates = getDefaultDates();
  const [dateRange, setDateRange] = useState(defaultDates);
  const [mode, setMode] = useState<'live' | 'paper' | 'mixed'>('live');
  const theme = useChartTheme();

  const { data: tradeSummary, isLoading: loadingTrades } = useQuery({
    queryKey: ['analytics', 'trades', dateRange, mode],
    queryFn: () => analyticsService.getTradeSummary(dateRange.fromDate, dateRange.toDate, mode),
  });
  const { data: dailyPnl, isLoading: loadingDailyPnl } = useQuery({
    queryKey: ['analytics', 'tradesPnl', dateRange, mode],
    queryFn: () => analyticsService.getDailyPnlSummary(dateRange.fromDate, dateRange.toDate, mode),
  });
  const { data: strategyPnl, isLoading: loadingStrategyPnl } = useQuery({
    queryKey: ['analytics', 'tradesByStrategy', dateRange, mode],
    queryFn: () => analyticsService.getPnlByStrategy(dateRange.fromDate, dateRange.toDate, mode),
  });
  const { data: tradeDistribution, isLoading: loadingDistribution } = useQuery({
    queryKey: ['analytics', 'tradesDistribution', dateRange, mode],
    queryFn: () => analyticsService.getTradeDistribution(dateRange.fromDate, dateRange.toDate, mode),
  });

  const chartOptions = {
    ...currencyChartOptions,
    scales: {
      x: { grid: { color: theme.grid }, ticks: { ...currencyChartOptions.scales.x.ticks, color: theme.axisTick } },
      y: { grid: { color: theme.grid }, ticks: { ...currencyChartOptions.scales.y.ticks, color: theme.axisTick } },
    },
  };

  const dailyPnlData = {
    labels: dailyPnl?.map((d) => d.date) || [],
    datasets: [{ label: 'Net P&L', data: dailyPnl?.map((d) => d.netPnl) || [], borderColor: 'rgb(45, 206, 137)', backgroundColor: dailyPnl?.map((d) => (d.netPnl >= 0 ? 'rgba(45, 206, 137, 0.5)' : 'rgba(220, 53, 69, 0.5)')) || [], fill: true, tension: 0.4 }],
  };

  const strategyPnlData = {
    labels: strategyPnl?.slice(0, 10).map((s) => s.strategyName) || [],
    datasets: [{ label: 'Net P&L', data: strategyPnl?.slice(0, 10).map((s) => s.netPnl) || [], backgroundColor: strategyPnl?.slice(0, 10).map((s) => (s.netPnl >= 0 ? 'rgba(45, 206, 137, 0.8)' : 'rgba(220, 53, 69, 0.8)')) || [] }],
  };

  const tradesByBrokerData = {
    labels: tradeDistribution?.byBroker?.map((d) => d.name) || [],
    datasets: [{ data: tradeDistribution?.byBroker?.map((d) => d.count) || [], backgroundColor: ['rgba(45, 206, 137, 0.8)', 'rgba(17, 205, 239, 0.8)', 'rgba(251, 99, 64, 0.8)', 'rgba(94, 114, 228, 0.8)', 'rgba(136, 152, 170, 0.8)'] }],
  };

  const tradesByProductData = {
    labels: tradeDistribution?.byProduct?.map((d) => d.name) || [],
    datasets: [{ data: tradeDistribution?.byProduct?.map((d) => d.count) || [], backgroundColor: ['rgba(45, 206, 137, 0.8)', 'rgba(251, 99, 64, 0.8)', 'rgba(17, 205, 239, 0.8)'] }],
  };

  const isLoading = loadingTrades || loadingDailyPnl || loadingStrategyPnl || loadingDistribution;

  const totalWinsLosses = (tradeSummary?.totalWins || 0) + (tradeSummary?.totalLosses || 0);
  const winRate = totalWinsLosses > 0 ? (((tradeSummary?.totalWins || 0) / totalWinsLosses) * 100).toFixed(1) : 0;
  const intradayWinsLosses = (tradeSummary?.intradayWins || 0) + (tradeSummary?.intradayLosses || 0);
  const intradayWinRate = intradayWinsLosses > 0 ? (((tradeSummary?.intradayWins || 0) / intradayWinsLosses) * 100).toFixed(1) : 0;
  const positionalWinsLosses = (tradeSummary?.positionalWins || 0) + (tradeSummary?.positionalLosses || 0);
  const positionalWinRate = positionalWinsLosses > 0 ? (((tradeSummary?.positionalWins || 0) / positionalWinsLosses) * 100).toFixed(1) : 0;

  return (
    <div className="fade-in">
      <PageHeader
        title="Trade Analytics"
        subtitle="Trade performance, P&L analysis, and strategy metrics"
        icon={<BsGraphUp size={24} />}
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
          {/* Summary Stats Row 1 - Trade Counts */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Total Trades" value={tradeSummary?.totalTrades || 0} icon={BsActivity} iconBg="primary" />
            <StatCard title="Intraday Trades" value={tradeSummary?.intradayTrades || 0} icon={BsGraphUp} iconBg="info" />
            <StatCard title="Positional Trades" value={tradeSummary?.positionalTrades || 0} icon={BsGraphDown} iconBg="warning" />
            <StatCard title="Active Positions" value={tradeSummary?.activePositions || 0} icon={BsActivity} iconBg="secondary" />
          </div>

          {/* Summary Stats Row 2 - P&L */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Total P&L" value={tradeSummary?.totalPnl || 0} prefix="₹" icon={(tradeSummary?.totalPnl || 0) >= 0 ? BsArrowUpRight : BsArrowDownRight} iconBg={(tradeSummary?.totalPnl || 0) >= 0 ? 'success' : 'danger'} />
            <StatCard title="Intraday P&L" value={tradeSummary?.intradayPnl || 0} prefix="₹" icon={(tradeSummary?.intradayPnl || 0) >= 0 ? BsArrowUpRight : BsArrowDownRight} iconBg={(tradeSummary?.intradayPnl || 0) >= 0 ? 'success' : 'danger'} />
            <StatCard title="Positional P&L" value={tradeSummary?.positionalPnl || 0} prefix="₹" icon={(tradeSummary?.positionalPnl || 0) >= 0 ? BsArrowUpRight : BsArrowDownRight} iconBg={(tradeSummary?.positionalPnl || 0) >= 0 ? 'success' : 'danger'} />
            <StatCard title="Total Charges" value={tradeSummary?.totalCharges || 0} prefix="₹" icon={BsGraphDown} iconBg="secondary" />
          </div>

          {/* Summary Stats Row 3 - Win/Loss */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Total Wins" value={tradeSummary?.totalWins || 0} icon={BsCheckCircle} iconBg="success" />
            <StatCard title="Total Losses" value={tradeSummary?.totalLosses || 0} icon={BsXCircle} iconBg="danger" />
            <StatCard title="Win Rate" value={Number(winRate)} suffix="%" icon={BsActivity} iconBg={Number(winRate) >= 50 ? 'success' : 'warning'} />
            <StatCard title="Net P&L (After Charges)" value={(tradeSummary?.totalPnl || 0) - (tradeSummary?.totalCharges || 0)} prefix="₹" icon={BsGraphUp} iconBg={(tradeSummary?.totalPnl || 0) - (tradeSummary?.totalCharges || 0) >= 0 ? 'success' : 'danger'} />
          </div>

          {/* Daily P&L Chart */}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className={`${card} lg:col-span-2`}>
              <div className={cardHead}>Daily P&L Trend</div>
              <div className="p-4">
                {dailyPnl && dailyPnl.length > 0 ? (
                  <div className="chart-container">
                    <Line data={dailyPnlData} options={chartOptions} />
                  </div>
                ) : (
                  <div className={info}>No daily P&L data available</div>
                )}
              </div>
            </div>

            <div className={card}>
              <div className={cardHead}>Win/Loss Breakdown</div>
              <div className="p-4">
                <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                  <thead className="bg-raised text-xs uppercase text-ink-faint">
                    <tr>
                      <th className={`${cell} text-left`}>Type</th>
                      <th className={`${cell} text-center`}>Wins</th>
                      <th className={`${cell} text-center`}>Losses</th>
                      <th className={`${cell} text-right`}>Win Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className={`${cell} font-medium text-ink`}>Overall</td>
                      <td className={`${cell} text-center text-success-500`}>{tradeSummary?.totalWins || 0}</td>
                      <td className={`${cell} text-center text-danger-500`}>{tradeSummary?.totalLosses || 0}</td>
                      <td className={`${cell} text-right`}>
                        <Badge tone={winTone(Number(winRate))}>{winRate}%</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className={`${cell} text-ink`}>Intraday</td>
                      <td className={`${cell} text-center text-success-500`}>{tradeSummary?.intradayWins || 0}</td>
                      <td className={`${cell} text-center text-danger-500`}>{tradeSummary?.intradayLosses || 0}</td>
                      <td className={`${cell} text-right`}>
                        <Badge tone={winTone(Number(intradayWinRate))}>{intradayWinRate}%</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className={`${cell} text-ink`}>Positional</td>
                      <td className={`${cell} text-center text-success-500`}>{tradeSummary?.positionalWins || 0}</td>
                      <td className={`${cell} text-center text-danger-500`}>{tradeSummary?.positionalLosses || 0}</td>
                      <td className={`${cell} text-right`}>
                        <Badge tone={winTone(Number(positionalWinRate))}>{positionalWinRate}%</Badge>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Strategy P&L */}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className={`${card} lg:col-span-2`}>
              <div className={cardHead}>P&L by Strategy (Top 10)</div>
              <div className="p-4">
                {strategyPnl && strategyPnl.length > 0 ? (
                  <div className="chart-container">
                    <Bar data={strategyPnlData} options={{ ...chartOptions, indexAxis: 'y' }} />
                  </div>
                ) : (
                  <div className={info}>No strategy P&L data available</div>
                )}
              </div>
            </div>

            <div className={card}>
              <div className={cardHead}>Strategy Performance</div>
              <div>
                <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                  <thead className="bg-raised text-xs uppercase text-ink-faint">
                    <tr>
                      <th className={`${cell} text-left`}>Strategy</th>
                      <th className={`${cell} text-right`}>Trades</th>
                      <th className={`${cell} text-right`}>P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strategyPnl?.slice(0, 8).map((s) => (
                      <tr key={s.strategyName}>
                        <td className={`${cell} max-w-[120px] truncate text-ink`} title={s.strategyName}>{s.strategyName}</td>
                        <td className={`${cell} text-right text-ink`}>{s.tradeCount}</td>
                        <td className={`${cell} text-right ${s.netPnl >= 0 ? 'text-success-500' : 'text-danger-500'}`}>{formatIndianNumber(s.netPnl, false)}</td>
                      </tr>
                    )) || (
                      <tr>
                        <td colSpan={3} className={`${cell} py-3 text-center text-ink-soft`}>No data</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Distribution Charts */}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className={card}>
              <div className={cardHead}>Trades by Broker</div>
              <div className="flex items-center justify-center p-4">
                {tradeDistribution?.byBroker && tradeDistribution.byBroker.length > 0 ? (
                  <div style={{ width: '100%', maxWidth: 300 }}>
                    <Doughnut data={tradesByBrokerData} options={{ ...chartOptions, plugins: { legend: { display: true, position: 'bottom' } } }} />
                  </div>
                ) : (
                  <div className={info}>No broker distribution data</div>
                )}
              </div>
            </div>

            <div className={card}>
              <div className={cardHead}>Trades by Product Type</div>
              <div className="flex items-center justify-center p-4">
                {tradeDistribution?.byProduct && tradeDistribution.byProduct.length > 0 ? (
                  <div style={{ width: '100%', maxWidth: 300 }}>
                    <Doughnut data={tradesByProductData} options={{ ...chartOptions, plugins: { legend: { display: true, position: 'bottom' } } }} />
                  </div>
                ) : (
                  <div className={info}>No product distribution data</div>
                )}
              </div>
            </div>
          </div>

          {/* Daily P&L Table */}
          <div className={card}>
            <div className={cardHead}>Daily P&L Details</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className="bg-raised text-xs uppercase text-ink-faint">
                  <tr>
                    <th className={`${cell} text-left`}>Date</th>
                    <th className={`${cell} text-right`}>Gross P&L</th>
                    <th className={`${cell} text-right`}>Charges</th>
                    <th className={`${cell} text-right`}>Net P&L</th>
                    <th className={`${cell} text-center`}>Users</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyPnl && dailyPnl.length > 0 ? (
                    [...dailyPnl].reverse().slice(0, 15).map((d) => (
                      <tr key={d.date} className="hover:bg-raised/50">
                        <td className={`${cell} text-ink`}>{d.date} ({new Date(d.date).toLocaleDateString('en-US', { weekday: 'short' })})</td>
                        <td className={`${cell} text-right ${d.pnl >= 0 ? 'text-success-500' : 'text-danger-500'}`}>{formatIndianNumber(d.pnl, false)}</td>
                        <td className={`${cell} text-right text-ink-soft`}>{formatIndianNumber(d.charges, false)}</td>
                        <td className={`${cell} text-right font-bold ${d.netPnl >= 0 ? 'text-success-500' : 'text-danger-500'}`}>{formatIndianNumber(d.netPnl, false)}</td>
                        <td className={`${cell} text-center`}>
                          <Badge tone="neutral">{d.userCount}</Badge>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="py-4 text-center text-ink-soft">No daily P&L data available</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default TradeAnalytics;
