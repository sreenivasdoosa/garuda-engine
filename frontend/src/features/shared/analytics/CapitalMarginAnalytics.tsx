/**
 * Capital & Margin Analytics Page
 * Daily capital records, margin records, capital distribution
 */

import { useState, useEffect } from 'react';
import clsx from 'clsx';
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
import { BsCurrencyRupee, BsGraphUp, BsPercent } from 'react-icons/bs';

import { PageHeader, StatCard } from '@/components/common';
import TablePagination from '@/components/common/TablePagination';
import { DEFAULT_PAGE_SIZE } from '@/types/pagination';
import UserSelect from '@/components/common/UserSelect';
import { analyticsService } from '@/services/admin/analyticsService';
import { userCapitalService, userMarginService } from '@/services/admin/v2AdminService';
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
const label = 'mb-1 block text-xs text-ink-soft';
const ctrl = 'h-8 w-full rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';
const dangerBox = 'm-3 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-sm text-danger-600 dark:text-danger-400';

const utilTone = (pct: number): Tone => (pct > 80 ? 'danger' : pct > 50 ? 'warning' : 'success');
const utilBg = (pct: number) => (pct > 80 ? 'danger' : pct > 50 ? 'warning' : 'success');

const useThemedCurrencyOptions = () => {
  const theme = useChartTheme();
  return {
    ...currencyChartOptions,
    scales: {
      x: { grid: { color: theme.grid }, ticks: { ...currencyChartOptions.scales.x.ticks, color: theme.axisTick } },
      y: { grid: { color: theme.grid }, ticks: { ...currencyChartOptions.scales.y.ticks, color: theme.axisTick } },
    },
  };
};

const TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'capital-records', label: 'Daily Capital Records' },
  { key: 'margin-records', label: 'Daily Margin Records' },
];

const CapitalMarginAnalytics: React.FC = () => {
  const [activeTab, setActiveTab] = useState('summary');

  return (
    <div className="fade-in">
      <PageHeader title="Capital & Margin Analytics" subtitle="Capital trends, margin utilization, and distribution analysis" icon={<BsCurrencyRupee size={24} />} />

      <div className="mb-3 flex flex-wrap gap-1 border-b border-hairline">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={clsx(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              activeTab === t.key ? 'border-primary-500 text-primary-500' : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {activeTab === 'summary' && <CapitalMarginSummary />}
      {activeTab === 'capital-records' && <DailyCapitalRecords />}
      {activeTab === 'margin-records' && <DailyMarginRecords />}
    </div>
  );
};

// ==================== SUMMARY TAB ====================
const CapitalMarginSummary: React.FC = () => {
  const getDefaultDates = () => {
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);
    return { fromDate: thirtyDaysAgo.toISOString().split('T')[0], toDate: today.toISOString().split('T')[0] };
  };

  const defaultDates = getDefaultDates();
  const [dateRange, setDateRange] = useState(defaultDates);
  const chartOptions = useThemedCurrencyOptions();

  const { data: capitalSummary, isLoading: loadingCapital } = useQuery({
    queryKey: ['analytics', 'capital', dateRange],
    queryFn: () => analyticsService.getDailyCapitalSummary(dateRange.fromDate, dateRange.toDate),
  });
  const { data: marginSummary, isLoading: loadingMargin } = useQuery({
    queryKey: ['analytics', 'margins', dateRange],
    queryFn: () => analyticsService.getDailyMarginSummary(dateRange.fromDate, dateRange.toDate),
  });
  const { data: capitalDistribution, isLoading: loadingDistribution } = useQuery({
    queryKey: ['analytics', 'capitalDistribution', dateRange.toDate],
    queryFn: () => analyticsService.getCapitalDistribution(dateRange.toDate),
  });

  const capitalTrendData = {
    labels: capitalSummary?.map((d) => d.date) || [],
    datasets: [{ label: 'Total Capital', data: capitalSummary?.map((d) => d.totalCapital) || [], borderColor: 'rgb(45, 206, 137)', backgroundColor: 'rgba(45, 206, 137, 0.1)', fill: true, tension: 0.4 }],
  };
  const marginTrendData = {
    labels: marginSummary?.map((d) => d.date) || [],
    datasets: [{ label: 'Utilization %', data: marginSummary?.map((d) => d.utilizationPercent) || [], borderColor: 'rgb(251, 99, 64)', backgroundColor: 'rgba(251, 99, 64, 0.1)', fill: true, tension: 0.4 }],
  };
  const capitalByBrokerData = {
    labels: capitalDistribution?.byBroker?.map((d) => d.name) || [],
    datasets: [{ data: capitalDistribution?.byBroker?.map((d) => d.count) || [], backgroundColor: ['rgba(45, 206, 137, 0.8)', 'rgba(17, 205, 239, 0.8)', 'rgba(251, 99, 64, 0.8)', 'rgba(94, 114, 228, 0.8)', 'rgba(136, 152, 170, 0.8)'] }],
  };

  const latestCapital = capitalSummary && capitalSummary.length > 0 ? capitalSummary[capitalSummary.length - 1] : null;
  const latestMargin = marginSummary && marginSummary.length > 0 ? marginSummary[marginSummary.length - 1] : null;
  const isLoading = loadingCapital || loadingMargin || loadingDistribution;

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <input type="date" className={ctrl + ' w-auto'} value={dateRange.fromDate} onChange={(e) => setDateRange({ ...dateRange, fromDate: e.target.value })} />
        <span className="text-xs text-ink-soft">to</span>
        <input type="date" className={ctrl + ' w-auto'} value={dateRange.toDate} onChange={(e) => setDateRange({ ...dateRange, toDate: e.target.value })} />
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-primary-500">
          <Spinner />
        </div>
      ) : (
        <>
          {/* Summary Stats */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Latest Total Capital" value={latestCapital?.totalCapital || 0} prefix="₹" icon={BsCurrencyRupee} iconBg="success" />
            <StatCard title="Active Users (Capital)" value={latestCapital?.userCount || 0} icon={BsGraphUp} iconBg="primary" />
            <StatCard title="Latest Peak Margin" value={latestMargin?.totalPeakMargin || 0} prefix="₹" icon={BsCurrencyRupee} iconBg="warning" />
            <StatCard title="Margin Utilization" value={latestMargin?.utilizationPercent || 0} suffix="%" icon={BsPercent} iconBg={utilBg(latestMargin?.utilizationPercent || 0)} />
          </div>

          {/* Capital Trend */}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className={`${card} lg:col-span-2`}>
              <div className={cardHead}>Capital Trend</div>
              <div className="p-4">
                {capitalSummary && capitalSummary.length > 0 ? (
                  <div className="chart-container">
                    <Line data={capitalTrendData} options={chartOptions} />
                  </div>
                ) : (
                  <div className={info}>No capital data for selected period</div>
                )}
              </div>
            </div>

            <div className={card}>
              <div className={cardHead}>Capital by Broker</div>
              <div className="flex items-center justify-center p-4">
                {capitalDistribution?.byBroker && capitalDistribution.byBroker.length > 0 ? (
                  <div style={{ width: '100%', maxWidth: 250 }}>
                    <Doughnut data={capitalByBrokerData} options={{ ...chartOptions, plugins: { legend: { display: true, position: 'bottom' } } }} />
                  </div>
                ) : (
                  <div className={info}>No distribution data</div>
                )}
              </div>
            </div>
          </div>

          {/* Margin Utilization Trend */}
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className={`${card} lg:col-span-2`}>
              <div className={cardHead}>Margin Utilization Trend (%)</div>
              <div className="p-4">
                {marginSummary && marginSummary.length > 0 ? (
                  <div className="chart-container">
                    <Line data={marginTrendData} options={chartOptions} />
                  </div>
                ) : (
                  <div className={info}>No margin data for selected period</div>
                )}
              </div>
            </div>

            <div className={card}>
              <div className={cardHead}>Top Capital Users</div>
              <div>
                <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                  <thead className="bg-raised text-xs uppercase text-ink-faint">
                    <tr>
                      <th className={`${cell} text-left`}>User</th>
                      <th className={`${cell} text-right`}>Capital</th>
                    </tr>
                  </thead>
                  <tbody>
                    {capitalDistribution?.byUser?.slice(0, 10).map((u) => (
                      <tr key={u.name}>
                        <td className={`${cell} text-ink`}>{u.name}</td>
                        <td className={`${cell} text-right text-ink`}>{formatIndianNumber(u.count)}</td>
                      </tr>
                    )) || (
                      <tr>
                        <td colSpan={2} className={`${cell} py-3 text-center text-ink-soft`}>No data</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
};

// ==================== DAILY CAPITAL RECORDS TAB ====================
const DailyCapitalRecords: React.FC = () => {
  const getDefaultDates = () => {
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);
    return { fromDate: thirtyDaysAgo.toISOString().split('T')[0], toDate: today.toISOString().split('T')[0] };
  };

  const defaultDates = getDefaultDates();
  const [filter, setFilter] = useState({ username: '', fromDate: defaultDates.fromDate, toDate: defaultDates.toDate });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [filter.username, filter.fromDate, filter.toDate, pageSize]);

  const { data: recordsPage, isLoading, error } = useQuery({
    queryKey: ['admin', 'userCapital', filter, page, pageSize],
    queryFn: () => userCapitalService.getCapitalRecordsPaginated({ username: filter.username || undefined, fromDate: filter.fromDate, toDate: filter.toDate, page, pageSize }),
  });
  const records = recordsPage?.data;
  const pagination = recordsPage?.pagination;

  return (
    <div className={card}>
      <div className="border-b border-hairline p-3">
        <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-3">
          <div>
            <label className={label}>Username</label>
            <UserSelect value={filter.username} onChange={(username) => setFilter({ ...filter, username })} />
          </div>
          <div>
            <label className={label}>From Date</label>
            <input type="date" className={ctrl} value={filter.fromDate} onChange={(e) => setFilter({ ...filter, fromDate: e.target.value })} />
          </div>
          <div>
            <label className={label}>To Date</label>
            <input type="date" className={ctrl} value={filter.toDate} onChange={(e) => setFilter({ ...filter, toDate: e.target.value })} />
          </div>
        </div>
      </div>
      <div>
        {isLoading ? (
          <div className="py-10 text-center text-primary-500">
            <Spinner />
          </div>
        ) : error ? (
          <div className={dangerBox}>Failed to load capital records</div>
        ) : (
          <>
            {pagination && (
              <div className="px-3 pt-2">
                <TablePagination page={pagination.page} pageSize={pagination.pageSize} totalCount={pagination.totalCount} totalPages={pagination.totalPages} onPageChange={setPage} onPageSizeChange={setPageSize} itemLabel="records" loading={isLoading} />
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className="bg-raised text-xs uppercase text-ink-faint">
                  <tr>
                    <th className={`${cell} text-left`}>Username</th>
                    <th className={`${cell} text-left`}>Broker</th>
                    <th className={`${cell} text-left`}>Date</th>
                    <th className={`${cell} text-right`}>Capital</th>
                  </tr>
                </thead>
                <tbody>
                  {!records || records.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-4 text-center text-ink-soft">No capital records found</td>
                    </tr>
                  ) : (
                    records.map((r, i) => (
                      <tr key={i} className="hover:bg-raised/50">
                        <td className={`${cell} font-medium text-ink`}>{r.username}</td>
                        <td className={cell}>
                          <Badge tone="neutral">{r.broker}</Badge>
                        </td>
                        <td className={`${cell} text-ink`}>{r.dateStr}</td>
                        <td className={`${cell} text-right text-ink`}>{formatIndianNumber(r.capital)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ==================== DAILY MARGIN RECORDS TAB ====================
const DailyMarginRecords: React.FC = () => {
  const getDefaultDates = () => {
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);
    return { fromDate: thirtyDaysAgo.toISOString().split('T')[0], toDate: today.toISOString().split('T')[0] };
  };

  const defaultDates = getDefaultDates();
  const [filter, setFilter] = useState({ username: '', fromDate: defaultDates.fromDate, toDate: defaultDates.toDate });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [filter.username, filter.fromDate, filter.toDate, pageSize]);

  const { data: marginsPage, isLoading, error } = useQuery({
    queryKey: ['admin', 'userMargins', filter, page, pageSize],
    queryFn: () => userMarginService.getMarginsPaginated({ username: filter.username || undefined, fromDate: filter.fromDate, toDate: filter.toDate, page, pageSize }),
  });
  const margins = marginsPage?.data;
  const pagination = marginsPage?.pagination;

  return (
    <div className={card}>
      <div className="border-b border-hairline p-3">
        <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-3">
          <div>
            <label className={label}>Username</label>
            <UserSelect value={filter.username} onChange={(username) => setFilter({ ...filter, username })} />
          </div>
          <div>
            <label className={label}>From Date</label>
            <input type="date" className={ctrl} value={filter.fromDate} onChange={(e) => setFilter({ ...filter, fromDate: e.target.value })} />
          </div>
          <div>
            <label className={label}>To Date</label>
            <input type="date" className={ctrl} value={filter.toDate} onChange={(e) => setFilter({ ...filter, toDate: e.target.value })} />
          </div>
        </div>
      </div>
      <div>
        {isLoading ? (
          <div className="py-10 text-center text-primary-500">
            <Spinner />
          </div>
        ) : error ? (
          <div className={dangerBox}>Failed to load margin records</div>
        ) : (
          <>
            {pagination && (
              <div className="px-3 pt-2">
                <TablePagination page={pagination.page} pageSize={pagination.pageSize} totalCount={pagination.totalCount} totalPages={pagination.totalPages} onPageChange={setPage} onPageSizeChange={setPageSize} itemLabel="records" loading={isLoading} />
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className="bg-raised text-xs uppercase text-ink-faint">
                  <tr>
                    <th className={`${cell} text-left`}>Username</th>
                    <th className={`${cell} text-left`}>Broker</th>
                    <th className={`${cell} text-left`}>Date</th>
                    <th className={`${cell} text-right`}>Peak Margin</th>
                    <th className={`${cell} text-right`}>Total Margin</th>
                    <th className={`${cell} text-right`}>Peak Margin (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {!margins || margins.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-4 text-center text-ink-soft">No margin records found</td>
                    </tr>
                  ) : (
                    margins.map((m, i) => {
                      const peakPercentage = m.totalMargin > 0 ? (m.peakMargin / m.totalMargin) * 100 : 0;
                      return (
                        <tr key={i} className="hover:bg-raised/50">
                          <td className={`${cell} font-medium text-ink`}>{m.username}</td>
                          <td className={cell}>
                            <Badge tone="neutral">{m.broker}</Badge>
                          </td>
                          <td className={`${cell} text-ink`}>{m.date} ({new Date(m.date).toLocaleDateString('en-US', { weekday: 'short' })})</td>
                          <td className={`${cell} text-right text-ink`}>{formatIndianNumber(m.peakMargin)}</td>
                          <td className={`${cell} text-right text-ink`}>{formatIndianNumber(m.totalMargin)}</td>
                          <td className={`${cell} text-right`}>
                            <Badge tone={utilTone(peakPercentage)}>{peakPercentage.toFixed(1)}%</Badge>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default CapitalMarginAnalytics;
