/**
 * RMS Daily Stats Page
 * View daily order statistics per user/broker/symbol from USER_RMS_DAILY_STATS table
 */

import { useState, useMemo } from 'react';
import { BsArrowClockwise, BsCardChecklist, BsXCircle } from 'react-icons/bs';
import { PageHeader } from '@/components/common';
import UserSelect from '@/components/common/UserSelect';
import { useQuery } from '@tanstack/react-query';
import { rmsConfigService } from '@/services/admin/v2AdminService';
import { Button, Spinner } from '@/components/ui';

const getToday = () => new Date().toISOString().split('T')[0];

const label = 'mb-1 block text-xs text-ink-soft';
const ctrl = 'h-8 w-full rounded border border-hairline bg-card px-2 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';
const cell = 'px-2 py-1.5 text-[0.8rem]';

const RMSDailyStatsPage: React.FC = () => {
  const [date, setDate] = useState(getToday());
  const [usernameFilter, setUsernameFilter] = useState('');

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['rms-daily-stats', date, usernameFilter],
    queryFn: () => rmsConfigService.getDailyStats({ date: date || undefined, username: usernameFilter || undefined }),
    refetchInterval: 30000,
  });

  const stats = data?.stats || [];
  const totalOrders = data?.totalOrders || 0;
  const totalBuyOrders = data?.totalBuyOrders || 0;
  const totalSellOrders = data?.totalSellOrders || 0;
  const uniqueSymbols = data?.uniqueSymbols || 0;

  const hasActiveFilters = useMemo(() => !!(usernameFilter || date !== getToday()), [usernameFilter, date]);

  const resetFilters = () => {
    setUsernameFilter('');
    setDate(getToday());
  };

  if (error) {
    return (
      <>
        <PageHeader title="RMS Daily Stats" subtitle="Daily order statistics per user/broker/symbol" icon={<BsCardChecklist size={24} />} />
        <div className="rounded-card border border-hairline bg-card py-4 text-center text-danger-600 dark:text-danger-400">Failed to load daily stats</div>
      </>
    );
  }

  const statCards = [
    { value: totalOrders, label: 'Total Orders', color: totalOrders > 0 ? 'text-primary-500' : 'text-ink-faint' },
    { value: totalBuyOrders, label: 'Buy Orders', color: 'text-success-500' },
    { value: totalSellOrders, label: 'Sell Orders', color: 'text-danger-500' },
    { value: uniqueSymbols, label: 'Unique Symbols', color: 'text-accent-500' },
  ];

  return (
    <div>
      <PageHeader title="RMS Daily Stats" subtitle="Daily order statistics per user/broker/symbol" icon={<BsCardChecklist size={24} />} />

      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {statCards.map((c) => (
          <div key={c.label} className="rounded-card border border-hairline bg-card p-4 text-center">
            <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
            <div className="text-xs text-ink-soft">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="rounded-card border border-hairline bg-card">
        <div className="flex items-center justify-between border-b border-hairline p-3">
          <div className="flex items-center gap-2">
            <h5 className="mb-0 flex items-center gap-2 font-semibold text-ink">
              <BsCardChecklist className="text-primary-500" />
              Daily Order Stats
            </h5>
            {isFetching && <Spinner size="sm" />}
          </div>
          <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <BsArrowClockwise className={isFetching ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>

        <div className="p-3">
          <div className="mb-3 grid grid-cols-1 items-end gap-2 md:grid-cols-4">
            <div>
              <label className={label}>Date</label>
              <input type="date" className={ctrl} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className={label}>Username</label>
              <UserSelect value={usernameFilter} onChange={setUsernameFilter} allOptionLabel="All Users" />
            </div>
            <div className="flex items-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDate(getToday())}>
                Today
              </Button>
              {hasActiveFilters && (
                <Button variant="danger" size="sm" onClick={resetFilters} title="Clear Filters">
                  <BsXCircle />
                </Button>
              )}
            </div>
          </div>

          <div className="mb-2 text-xs text-ink-soft">
            Showing {stats.length} record(s) for {date} &bull; Auto-refreshes every 30s
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
              <thead className="bg-raised text-xs uppercase text-ink-faint">
                <tr>
                  <th className={`${cell} text-left`} style={{ width: '120px' }}>Username</th>
                  <th className={`${cell} text-left`} style={{ width: '120px' }}>Broker</th>
                  <th className={`${cell} text-left`}>Trading Symbol</th>
                  <th className={`${cell} text-right`} style={{ width: '100px' }}>Orders</th>
                  <th className={`${cell} text-right`} style={{ width: '100px' }}>Buy Orders</th>
                  <th className={`${cell} text-right`} style={{ width: '100px' }}>Sell Orders</th>
                  <th className={`${cell} text-right`} style={{ width: '100px' }}>Buy Qty</th>
                  <th className={`${cell} text-right`} style={{ width: '100px' }}>Sell Qty</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">
                      <Spinner size="sm" /> Loading daily stats...
                    </td>
                  </tr>
                ) : stats.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-center text-ink-soft">
                      No stats found for {date}
                    </td>
                  </tr>
                ) : (
                  stats.map((stat, idx) => (
                    <tr key={`${stat.username}-${stat.broker}-${stat.tradingSymbol}-${idx}`} className="hover:bg-raised/50">
                      <td className={cell}>
                        <span className="font-medium text-ink">{stat.username}</span>
                      </td>
                      <td className={`${cell} text-ink`}>{stat.broker}</td>
                      <td className={cell}>
                        <code className="text-ink">{stat.tradingSymbol}</code>
                      </td>
                      <td className={`${cell} text-right font-medium text-ink`}>{stat.orderCount}</td>
                      <td className={`${cell} text-right text-success-500`}>{stat.buyOrderCount}</td>
                      <td className={`${cell} text-right text-danger-500`}>{stat.sellOrderCount}</td>
                      <td className={`${cell} text-right text-ink`}>{stat.buyQty}</td>
                      <td className={`${cell} text-right text-ink`}>{stat.sellQty}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RMSDailyStatsPage;
