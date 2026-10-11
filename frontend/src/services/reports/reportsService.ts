import { api } from '@/api/client';
import type { DailyPnlResponse, ReportFilters, ReportFilterOptions, TradesReportResponse } from '@/types/reports';

const BASE = '/api/reports';

const clean = (params: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== false));

/** Save a file the API sent as an attachment. */
const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const reportsService = {
  /** What the dropdowns offer. */
  getFilters: () => api.get<ReportFilterOptions>(`${BASE}/filters`),

  /** One row per trade in the range, newest first, with totals. */
  getTrades: (filters: ReportFilters) => api.get<TradesReportResponse>(`${BASE}/trades`, clean(filters)),

  /** Closed trades summed by the day they ended; one strategy or all; split per strategy when asked. */
  getDailyPnl: (filters: ReportFilters) => api.get<DailyPnlResponse>(`${BASE}/daily-pnl`, clean(filters)),

  /** The same rows as a file: csv or xlsx. */
  async exportTrades(filters: ReportFilters, format: 'csv' | 'xlsx'): Promise<void> {
    const blob = await api.get<Blob>(`${BASE}/trades/export`, clean({ ...filters, format }), { responseType: 'blob' });
    save(blob, `trades_${filters.fromDate ?? ''}_${filters.toDate ?? ''}.${format}`);
  },
  async exportDailyPnl(filters: ReportFilters, format: 'csv' | 'xlsx'): Promise<void> {
    const blob = await api.get<Blob>(`${BASE}/daily-pnl/export`, clean({ ...filters, format }), { responseType: 'blob' });
    save(blob, `daily_pnl_${filters.fromDate ?? ''}_${filters.toDate ?? ''}.${format}`);
  },
};
