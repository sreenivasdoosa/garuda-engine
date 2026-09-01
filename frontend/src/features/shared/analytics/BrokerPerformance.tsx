/**
 * Broker Performance Page — Analytics, right below User Performance.
 *
 * Broker is a peer analytics dimension of user/strategy: a comparison table of
 * ALL brokers (net/gross/charges/users/days/ROI) plus an "Individual Broker
 * Performance" panel (select broker → daily net-P&L chart + per-user breakdown
 * within that broker). Server data is scoped to the requester's authorized
 * users (admin = all) and gated by the separate BROKER_ANALYTICS tool.
 */
import { useState, useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { useQuery } from '@tanstack/react-query';
import { BsBank, BsCalendar3, BsCurrencyRupee, BsTrophy, BsGraphUp } from 'react-icons/bs';

import { PageHeader, StatCard } from '@/components/common';
import { analyticsService } from '@/services/admin/analyticsService';
import { formatCurrency, formatNumber } from '@/utils/formatters';
import { currencyChartOptions } from '@/utils/chartOptions';
import { useChartTheme } from '@/hooks/useChartTheme';
import { Badge, Spinner } from '@/components/ui';
import type { Tone } from '@/components/ui';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

const info = 'rounded border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm text-ink';
const card = 'rounded-card border border-hairline bg-card';
const cardHead = 'border-b border-hairline px-4 py-3 text-sm font-semibold text-ink';
const cell = 'px-2 py-1.5';
const ctrl = 'h-8 rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';
const thRow = 'bg-raised text-xs uppercase text-ink-faint';

const pnlTone = (pnl: number): Tone => (pnl >= 0 ? 'success' : 'danger');
const pnlText = (v: number) => (v >= 0 ? 'text-success-500' : 'text-danger-500');

const BrokerPerformance: React.FC = () => {
  const getDefaultDates = () => {
    const today = new Date();
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(today.getMonth() - 6);
    return { fromDate: sixMonthsAgo.toISOString().split('T')[0], toDate: today.toISOString().split('T')[0] };
  };

  const [dateRange, setDateRange] = useState(getDefaultDates());
  const [mode, setMode] = useState<'live' | 'paper' | 'mixed'>('live');
  const [selectedBroker, setSelectedBroker] = useState<string>('');
  const theme = useChartTheme();

  const { data: brokers, isLoading: loadingBrokers } = useQuery({
    queryKey: ['analytics', 'brokerPerformance', dateRange, mode],
    queryFn: () => analyticsService.getBrokerDetailedPerformance(dateRange.fromDate, dateRange.toDate, mode),
  });
  const { data: brokerDaily, isLoading: loadingDaily } = useQuery({
    queryKey: ['analytics', 'brokerDailyPnl', selectedBroker, dateRange, mode],
    queryFn: () => analyticsService.getBrokerDailyPnl(selectedBroker, dateRange.fromDate, dateRange.toDate, mode),
    enabled: !!selectedBroker,
  });
  const { data: brokerUsers, isLoading: loadingUsers } = useQuery({
    queryKey: ['analytics', 'brokerUserBreakdown', selectedBroker, dateRange, mode],
    queryFn: () => analyticsService.getBrokerUserBreakdown(selectedBroker, dateRange.fromDate, dateRange.toDate, mode),
    enabled: !!selectedBroker,
  });

  const totals = useMemo(() => {
    const list = brokers ?? [];
    const netPnl = list.reduce((sum, b) => sum + b.netPnl, 0);
    const charges = list.reduce((sum, b) => sum + b.totalCharges, 0);
    const best = list.length ? list.reduce((a, b) => (b.netPnl > a.netPnl ? b : a)) : null;
    const worst = list.length ? list.reduce((a, b) => (b.netPnl < a.netPnl ? b : a)) : null;
    return { netPnl, charges, best, worst };
  }, [brokers]);

  const dailyChartData = useMemo(() => {
    if (!brokerDaily || brokerDaily.length === 0) return null;
    return {
      labels: brokerDaily.map((d) => d.date),
      datasets: [{
        label: 'Daily Net P&L',
        data: brokerDaily.map((d) => d.netPnl),
        backgroundColor: brokerDaily.map((d) => (d.netPnl >= 0 ? 'rgba(40, 167, 69, 0.8)' : 'rgba(220, 53, 69, 0.8)')),
        borderWidth: 0,
      }],
    };
  }, [brokerDaily]);

  const scales = {
    x: { grid: { color: theme.grid }, ticks: { ...currencyChartOptions.scales.x.ticks, color: theme.axisTick } },
    y: { grid: { color: theme.grid }, ticks: { ...currencyChartOptions.scales.y.ticks, color: theme.axisTick } },
  };
  const barChartOptions = { ...currencyChartOptions, scales, plugins: { ...currencyChartOptions.plugins, legend: { display: false } } };

  const selected = brokers?.find((b) => b.brokerName === selectedBroker);

  return (
    <div className="fade-in">
      <PageHeader
        title="Broker Performance"
        subtitle="Performance analytics grouped by broker"
        icon={<BsBank size={24} />}
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

      {loadingBrokers ? (
        <div className="py-10 text-center text-primary-500"><Spinner /></div>
      ) : (
        <>
          {/* Overview */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Brokers" value={brokers?.length || 0} icon={BsBank} iconBg="primary" />
            <StatCard title="Net P&L (all brokers)" value={formatCurrency(totals.netPnl)} icon={BsCurrencyRupee} iconBg={totals.netPnl >= 0 ? 'success' : 'danger'} />
            <StatCard title="Total Charges" value={formatCurrency(totals.charges)} icon={BsCurrencyRupee} iconBg="warning" />
            <StatCard title="Best Broker" value={totals.best ? totals.best.brokerName : '—'} icon={BsTrophy} iconBg="info" />
          </div>

          {/* Broker comparison table */}
          <div className="mb-4">
            <div className={card}>
              <div className={`${cardHead} flex items-center gap-2`}><BsGraphUp /> Broker Comparison</div>
              <div className="overflow-x-auto">
                {brokers && brokers.length > 0 ? (
                  <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                    <thead className={thRow}>
                      <tr>
                        <th className={`${cell} text-left`}>Broker</th>
                        <th className={`${cell} text-right`}>Users</th>
                        <th className={`${cell} text-right`}>Trading Days</th>
                        <th className={`${cell} text-right`}>Strategies</th>
                        <th className={`${cell} text-right`}>Gross P&L</th>
                        <th className={`${cell} text-right`}>Charges</th>
                        <th className={`${cell} text-right`}>Net P&L</th>
                        <th className={`${cell} text-right`}>ROI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {brokers.map((b) => (
                        <tr
                          key={b.brokerName}
                          className={`cursor-pointer hover:bg-raised/40 ${selectedBroker === b.brokerName ? 'bg-primary-500/10' : ''}`}
                          onClick={() => setSelectedBroker(b.brokerName)}
                          title="Click to view broker details below"
                        >
                          <td className={`${cell} font-medium text-ink`}>{b.brokerName}</td>
                          <td className={`${cell} text-right text-ink`}>{b.usersCount}</td>
                          <td className={`${cell} text-right text-ink`}>{b.tradingDays}</td>
                          <td className={`${cell} text-right text-ink`}>{b.strategiesUsed}</td>
                          <td className={`${cell} text-right ${pnlText(b.grossPnl)}`}>{formatCurrency(b.grossPnl)}</td>
                          <td className={`${cell} text-right text-ink`}>{formatCurrency(b.totalCharges)}</td>
                          <td className={`${cell} text-right font-semibold ${pnlText(b.netPnl)}`}>{formatCurrency(b.netPnl)}</td>
                          <td className={`${cell} text-right`}><Badge tone={pnlTone(b.roi)}>{formatNumber(b.roi, 2)}%</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="p-4"><div className={info}>No broker data for the selected period</div></div>
                )}
              </div>
            </div>
          </div>

          {/* Individual Broker Performance */}
          <div className="mb-4">
            <div className={card}>
              <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
                <h6 className="mb-0 text-sm font-semibold text-ink">Individual Broker Performance</h6>
                <select className={ctrl} style={{ width: 250 }} value={selectedBroker} onChange={(e) => setSelectedBroker(e.target.value)}>
                  <option value="">Select a broker...</option>
                  {(brokers ?? []).map((b) => (
                    <option key={b.brokerName} value={b.brokerName}>{b.brokerName}</option>
                  ))}
                </select>
              </div>
              <div className="p-4">
                {!selectedBroker ? (
                  <div className={info}>Select a broker (or click a comparison row) to view its performance breakdown</div>
                ) : (
                  <>
                    {selected && (
                      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                        <StatCard title="Net P&L" value={formatCurrency(selected.netPnl)} icon={BsCurrencyRupee} iconBg={selected.netPnl >= 0 ? 'success' : 'danger'} />
                        <StatCard title="Gross P&L" value={formatCurrency(selected.grossPnl)} icon={BsCurrencyRupee} iconBg="secondary" />
                        <StatCard title="Charges" value={formatCurrency(selected.totalCharges)} icon={BsCurrencyRupee} iconBg="warning" />
                        <StatCard title="Users" value={selected.usersCount} icon={BsBank} iconBg="primary" />
                        <StatCard title="Trading Days" value={selected.tradingDays} icon={BsCalendar3} iconBg="info" />
                        <StatCard title="Avg Daily P&L" value={formatCurrency(selected.avgDailyPnl)} icon={BsGraphUp} iconBg={selected.avgDailyPnl >= 0 ? 'success' : 'danger'} />
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                      <div className="lg:col-span-7">
                        <h6 className="mb-3 text-sm font-semibold text-ink">Daily P&L</h6>
                        {loadingDaily ? (
                          <div className="py-10 text-center text-primary-500"><Spinner size="sm" /></div>
                        ) : dailyChartData ? (
                          <div className="chart-container" style={{ height: 250 }}>
                            <Bar data={dailyChartData} options={barChartOptions} />
                          </div>
                        ) : (
                          <div className={info}>No daily P&L data for selected broker</div>
                        )}
                      </div>
                      <div className="lg:col-span-5">
                        <h6 className="mb-3 text-sm font-semibold text-ink">Users on this Broker</h6>
                        {loadingUsers ? (
                          <div className="py-10 text-center text-primary-500"><Spinner size="sm" /></div>
                        ) : brokerUsers && brokerUsers.length > 0 ? (
                          <div className="max-h-[300px] overflow-y-auto">
                            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                              <thead className={thRow}>
                                <tr>
                                  <th className={`${cell} text-left`}>User</th>
                                  <th className={`${cell} text-right`}>Days</th>
                                  <th className={`${cell} text-right`}>Net P&L</th>
                                  <th className={`${cell} text-right`}>ROI</th>
                                </tr>
                              </thead>
                              <tbody>
                                {brokerUsers.map((u) => (
                                  <tr key={u.userName}>
                                    <td className={`${cell} text-ink`}>{u.userName}</td>
                                    <td className={`${cell} text-right text-ink`}>{u.tradingDays}</td>
                                    <td className={`${cell} text-right ${pnlText(u.netPnl)}`}>{formatCurrency(u.netPnl)}</td>
                                    <td className={`${cell} text-right`}><Badge tone={pnlTone(u.roi)}>{formatNumber(u.roi, 2)}%</Badge></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className={info}>No user data for selected broker</div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default BrokerPerformance;
