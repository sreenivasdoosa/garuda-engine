/**
 * User Reports Service
 * API service for user's trade and EOD reports
 * Uses /api/v2/me/* endpoints (no username needed - extracted from JWT)
 */

import { api } from '@/api/client';
import type { TradeReport, EodPnlReport, ReportFilters } from '@/types/user-portal';

// User portal reports endpoints
const USER_REPORTS_ENDPOINTS = {
  TRADES: '/api/v2/me/trades',
  EOD: '/api/v2/me/reports/eod',
};

export const userReportsService = {
  /**
   * Get trade reports for current user
   */
  async getTradeReports(filters: ReportFilters): Promise<TradeReport[]> {
    const params: Record<string, string> = {
      fromDate: filters.fromDate,
      toDate: filters.toDate,
    };
    if (filters.broker) params.broker = filters.broker;
    if (filters.strategy) params.strategy = filters.strategy;

    return api.get<TradeReport[]>(USER_REPORTS_ENDPOINTS.TRADES, params);
  },

  /**
   * Get EOD P&L reports for current user
   */
  async getEodPnlReports(filters: ReportFilters): Promise<EodPnlReport[]> {
    const params: Record<string, string> = {
      fromDate: filters.fromDate,
      toDate: filters.toDate,
    };
    if (filters.broker) params.broker = filters.broker;
    if (filters.strategy) params.strategy = filters.strategy;

    return api.get<EodPnlReport[]>(USER_REPORTS_ENDPOINTS.EOD, params);
  },

  /**
   * Export trade reports to CSV
   */
  exportTradesToCsv(trades: TradeReport[], filename?: string): void {
    const headers = [
      'Date',
      'Broker',
      'Strategy',
      'Symbol',
      'Direction',
      'Quantity',
      'Entry Price',
      'Exit Price',
      'P&L',
      'Charges',
      'Net P&L',
      'Product',
      'Exit Reason',
    ];

    const rows = trades.map((trade) => {
      const tradeDate = trade.startTimestamp
        ? new Date(trade.startTimestamp).toISOString().split('T')[0]
        : '';
      return [
        tradeDate,
        trade.broker,
        trade.strategy,
        trade.tradingSymbol,
        trade.direction,
        trade.quantity,
        trade.entry || 0,
        trade.exit || 0,
        trade.profitLoss || 0,
        trade.charges || 0,
        trade.netProfitLoss || 0,
        trade.product || '',
        trade.exitReason || '',
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename || `trade-report-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  },

  /**
   * Export EOD P&L reports to CSV
   */
  exportEodPnlToCsv(reports: EodPnlReport[], filename?: string): void {
    const headers = [
      'Date',
      'Broker',
      'Strategy',
      'Product',
      'Capital',
      'P&L',
      'Charges',
      'Net P&L',
    ];

    const rows = reports.map((report) => [
      report.dateStr,
      report.broker,
      report.strategy || '',
      report.product || '',
      report.capital || 0,
      report.pl || 0,
      report.charges || 0,
      report.netPL || 0,
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename || `eod-pnl-report-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  },
};
