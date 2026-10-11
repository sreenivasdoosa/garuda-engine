/**
 * Analytics: one page, one Submit.
 *
 * Any combination of inputs is the question -- these accounts, those
 * brokers, these strategies, this product, live or paper, this range --
 * and a grouping says how the answer is cut. Nothing runs until Submit.
 */

import { useMemo, useState } from 'react';
import { BsGraphUp, BsPlayFill, BsXCircle } from 'react-icons/bs';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { PageHeader } from '@/components/common';
import { Badge, Button, Spinner } from '@/components/ui';
import { reportsService } from '@/services/reports/reportsService';
import { analyticsService } from '@/services/analytics/analyticsService';
import type { AnalyticsAnswer, AnalyticsBucket, AnalyticsQuestion, GroupBy } from '@/types/analytics';

const card = 'rounded-card border border-hairline bg-card';
const label = 'mb-1 block text-xs text-ink-soft';
const ctrl = 'w-full rounded border border-hairline bg-card px-2 py-1 text-sm text-ink focus-visible:outline-none focus:border-primary-500/60';
const cell = 'px-2 py-1.5 text-[0.8rem]';
const head = `${cell} text-left`;
const num = `${cell} text-right tabular-nums`;

const isoDay = (d: Date) => d.toISOString().split('T')[0];
const money = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : value;
};
const tone = (value: string | null | undefined) =>
  value === null || value === undefined ? 'text-ink-faint' : Number(value) > 0 ? 'text-success-500' : Number(value) < 0 ? 'text-danger-500' : 'text-ink';

const GROUP_LABELS: Record<GroupBy, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  account: 'Account',
  broker: 'Broker',
  strategy: 'Strategy',
  symbol: 'Symbol',
  product: 'Product',
  exit_reason: 'Exit reason',
  direction: 'Direction',
};

const MultiSelect: React.FC<{ title: string; options: { value: string; label: string }[]; chosen: string[]; onChange: (v: string[]) => void }> = ({ title, options, chosen, onChange }) => (
  <div>
    <span className={label}>{title} <span className="text-ink-faint">· none chosen means all</span></span>
    <select multiple className={`${ctrl} h-24`} value={chosen} onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  </div>
);

const Stat: React.FC<{ title: string; value: React.ReactNode; hint?: string }> = ({ title, value, hint }) => (
  <div className={`${card} p-3 text-center`}>
    <div className="text-lg font-bold text-ink">{value}</div>
    <div className="text-xs text-ink-soft">{title}</div>
    {hint && <div className="text-[0.7rem] text-ink-faint">{hint}</div>}
  </div>
);

const AnalyticsPage: React.FC = () => {
  const options = useQuery({ queryKey: ['analytics', 'options'], queryFn: () => analyticsService.getOptions(), staleTime: 60000 });
  const filters = useQuery({ queryKey: ['reports', 'filters'], queryFn: () => reportsService.getFilters(), staleTime: 60000 });

  const [fromDate, setFromDate] = useState(isoDay(new Date(Date.now() - 30 * 86400000)));
  const [toDate, setToDate] = useState(isoDay(new Date()));
  const [accounts, setAccounts] = useState<string[]>([]);
  const [brokers, setBrokers] = useState<string[]>([]);
  const [strategies, setStrategies] = useState<string[]>([]);
  const [products, setProducts] = useState<string[]>([]);
  const [paper, setPaper] = useState('live');
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  const [answer, setAnswer] = useState<AnalyticsAnswer | null>(null);
  const [asked, setAsked] = useState<AnalyticsQuestion | null>(null);

  const question = useMemo<AnalyticsQuestion>(
    () => ({
      fromDate,
      toDate,
      tradingClientIds: accounts.join(',') || undefined,
      brokers: brokers.join(',') || undefined,
      strategies: strategies.join(',') || undefined,
      products: products.join(',') || undefined,
      paper,
      groupBy,
    }),
    [fromDate, toDate, accounts, brokers, strategies, products, paper, groupBy],
  );

  const submit = useMutation({
    mutationFn: (q: AnalyticsQuestion) => analyticsService.ask(q),
    onSuccess: (result, q) => {
      setAnswer(result);
      setAsked(q);
    },
  });

  const reset = () => {
    setFromDate(isoDay(new Date(Date.now() - 30 * 86400000)));
    setToDate(isoDay(new Date()));
    setAccounts([]);
    setBrokers([]);
    setStrategies([]);
    setProducts([]);
    setPaper('live');
    setGroupBy('day');
  };

  const curve = (answer?.curve ?? []).map((p) => ({ day: p.tradingDay.slice(5), cumulative: Number(p.cumulative), dayPnl: Number(p.dayPnl), trades: p.trades }));
  const bars = (answer?.groups ?? []).map((g) => ({ name: g.label, pnl: Number(g.grossPnl) }));
  const chartColour = (v: number) => (v >= 0 ? '#22c55e' : '#ef4444');

  return (
    <div>
      <PageHeader title="Analytics" subtitle="Any combination of inputs, grouped as you choose, on Submit" icon={<BsGraphUp size={24} />} />

      <div className={`${card} mb-3 p-4`}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div>
            <span className={label}>From</span>
            <input type="date" className={ctrl} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <span className={label}>To</span>
            <input type="date" className={ctrl} value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <div>
            <span className={label}>Paper or live</span>
            <select className={ctrl} value={paper} onChange={(e) => setPaper(e.target.value)}>
              <option value="live">Live</option>
              <option value="paper">Paper</option>
              <option value="">Both</option>
            </select>
          </div>
          <div>
            <span className={label}>Group by</span>
            <select className={ctrl} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              {(options.data?.groupBy ?? (Object.keys(GROUP_LABELS) as GroupBy[])).map((g) => (
                <option key={g} value={g}>{GROUP_LABELS[g] ?? g}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2 xl:col-span-2">
            <Button variant="primary" onClick={() => submit.mutate(question)} disabled={submit.isPending}>
              {submit.isPending ? <Spinner size="sm" /> : <BsPlayFill />} Submit
            </Button>
            <Button variant="ghost" onClick={reset}><BsXCircle /> Reset</Button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MultiSelect title="Accounts" options={(options.data?.tradingClients ?? []).map((c) => ({ value: c.id, label: `${c.displayName} (${c.broker.toLowerCase()})` }))} chosen={accounts} onChange={setAccounts} />
          <MultiSelect title="Brokers" options={(options.data?.brokers ?? []).map((b) => ({ value: b, label: b }))} chosen={brokers} onChange={setBrokers} />
          <MultiSelect title="Strategies" options={(filters.data?.strategies ?? []).map((s) => ({ value: s, label: s }))} chosen={strategies} onChange={setStrategies} />
          <MultiSelect title="Products" options={(filters.data?.products ?? []).map((p) => ({ value: p, label: p }))} chosen={products} onChange={setProducts} />
        </div>
        {submit.error && <div className="mt-3 text-sm text-danger-500">{(submit.error as Error).message}</div>}
      </div>

      {!answer ? (
        <div className={`${card} p-6 text-center text-sm text-ink-soft`}>Choose what to ask and press Submit. Nothing runs until you do.</div>
      ) : (
        <>
          <div className="mb-3 text-xs text-ink-soft">
            {answer.fromDate} to {answer.toDate} · {asked?.paper === '' ? 'live and paper' : asked?.paper} · grouped by {GROUP_LABELS[answer.groupBy]}
            {asked?.tradingClientIds && <> · accounts {asked.tradingClientIds}</>}
            {asked?.brokers && <> · brokers {asked.brokers}</>}
            {asked?.strategies && <> · strategies {asked.strategies}</>}
            {asked?.products && <> · products {asked.products}</>}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat title="Gross P&L" value={<span className={tone(answer.overall.grossPnl)}>{money(answer.overall.grossPnl)}</span>} hint="charges not computed yet" />
            <Stat title="Closed trades" value={answer.overall.trades} hint={`${answer.overall.wins} won · ${answer.overall.losses} lost · ${answer.overall.flat} flat`} />
            <Stat title="Win rate" value={answer.overall.winRate ? `${answer.overall.winRate}%` : '—'} />
            <Stat title="Average trade" value={<span className={tone(answer.overall.averageTrade)}>{money(answer.overall.averageTrade)}</span>} />
            <Stat title="Average win / loss" value={`${money(answer.overall.averageWin)} / ${money(answer.overall.averageLoss)}`} />
            <Stat title="Best / worst" value={`${money(answer.overall.best)} / ${money(answer.overall.worst)}`} />
            <Stat title="Max drawdown" value={<span className="text-danger-500">{money(answer.overall.maxDrawdown)}</span>} hint="largest fall from a peak" />
            <Stat title="Profit factor" value={answer.overall.profitFactor ?? '—'} hint="gross wins over gross losses" />
          </div>

          <div className="mb-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
            <div className={`${card} p-3`}>
              <div className="mb-2 text-sm font-semibold text-ink">Cumulative P&L by day</div>
              {curve.length === 0 ? (
                <div className="py-8 text-center text-sm text-ink-soft">No closed trade in this selection.</div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={curve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.2)" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => v.toLocaleString('en-IN')} width={70} />
                    <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString('en-IN')} />
                    <Line type="monotone" dataKey="cumulative" stroke="#6b8cff" strokeWidth={2} dot={false} name="Cumulative" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className={`${card} p-3`}>
              <div className="mb-2 text-sm font-semibold text-ink">Gross P&L by {GROUP_LABELS[answer.groupBy].toLowerCase()}</div>
              {bars.length === 0 ? (
                <div className="py-8 text-center text-sm text-ink-soft">Nothing to group.</div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={bars.slice(0, 40)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.2)" />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={bars.length > 8 ? -35 : 0} textAnchor={bars.length > 8 ? 'end' : 'middle'} height={bars.length > 8 ? 60 : 30} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => v.toLocaleString('en-IN')} width={70} />
                    <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString('en-IN')} />
                    <Bar dataKey="pnl" name="Gross P&L" shape={(props: { x?: number; y?: number; width?: number; height?: number; payload?: { pnl: number } }) => {
                      const { x = 0, y = 0, width = 0, height = 0, payload } = props;
                      const h = Math.abs(height);
                      const top = height < 0 ? y + height : y;
                      return <rect x={x} y={top} width={width} height={h} fill={chartColour(payload?.pnl ?? 0)} rx={2} />;
                    }} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className={card}>
            <div className="flex items-center justify-between border-b border-hairline p-3">
              <h5 className="mb-0 font-semibold text-ink">By {GROUP_LABELS[answer.groupBy].toLowerCase()}</h5>
              <Badge tone="neutral">{answer.groups.length} group(s)</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline">
                <thead className="bg-raised text-xs uppercase text-ink-faint">
                  <tr>
                    <th className={head}>{GROUP_LABELS[answer.groupBy]}</th>
                    <th className={num}>Trades</th>
                    <th className={num}>Won</th>
                    <th className={num}>Lost</th>
                    <th className={num}>Win rate</th>
                    <th className={num}>Gross P&L</th>
                    <th className={num}>Avg trade</th>
                    <th className={num}>Avg win</th>
                    <th className={num}>Avg loss</th>
                    <th className={num}>Best</th>
                    <th className={num}>Worst</th>
                    <th className={num}>Max drawdown</th>
                    <th className={num}>Profit factor</th>
                  </tr>
                </thead>
                <tbody>
                  {answer.groups.length === 0 ? (
                    <tr><td colSpan={13} className="py-4 text-center text-ink-soft">No closed trade in this selection.</td></tr>
                  ) : (
                    answer.groups.map((g: AnalyticsBucket) => (
                      <tr key={g.key} className="hover:bg-raised/50">
                        <td className={`${cell} font-medium text-ink`}>{g.label}</td>
                        <td className={`${num} text-ink`}>{g.trades}</td>
                        <td className={`${num} text-success-500`}>{g.wins}</td>
                        <td className={`${num} text-danger-500`}>{g.losses}</td>
                        <td className={`${num} text-ink`}>{g.winRate ? `${g.winRate}%` : '—'}</td>
                        <td className={`${num} font-medium ${tone(g.grossPnl)}`}>{money(g.grossPnl)}</td>
                        <td className={`${num} ${tone(g.averageTrade)}`}>{money(g.averageTrade)}</td>
                        <td className={`${num} text-ink`}>{money(g.averageWin)}</td>
                        <td className={`${num} text-ink`}>{money(g.averageLoss)}</td>
                        <td className={`${num} text-ink`}>{money(g.best)}</td>
                        <td className={`${num} text-ink`}>{money(g.worst)}</td>
                        <td className={`${num} text-danger-500`}>{money(g.maxDrawdown)}</td>
                        <td className={`${num} text-ink`}>{g.profitFactor ?? '—'}</td>
                      </tr>
                    ))
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

export default AnalyticsPage;
