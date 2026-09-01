import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { NotFound } from '@/components/errors/ErrorPages';
import LoadingScreen from '@/components/common/LoadingScreen';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/store/authStore';
import { useConfigStore } from '@/store/configStore';
import ProtectedRoute from '@/routes/ProtectedRoute';

// Layouts
import AuthLayout from '@/layouts/AuthLayout';
import ConsoleLayout from '@/layouts/ConsoleLayout';
import TerminalLayout from '@/layouts/TerminalLayout';

// Auth
import LoginPage from '@/features/auth/LoginPage';

// Console
import ConsoleDashboard from '@/features/console/dashboard/ConsoleDashboard';
import AllocationModelsPage from '@/features/shared/allocation-models/AllocationModelsPage';
import AuditLogsPage from '@/features/shared/audit-logs/AuditLogsPage';
import BrokerConfigPage from '@/features/shared/broker-config/BrokerConfigPage';
import BrokerInstrumentsPage from '@/features/shared/broker-instruments/BrokerInstrumentsPage';
import BrokersPage from '@/features/shared/brokers/BrokersPage';
import ConsoleAlertsPage from '@/features/shared/alerts/AlertsPage';
import ConsoleReportsPage from '@/features/shared/reports/ReportsPage';
import CorporateActionsPage from '@/features/admin/corporate-actions/CorporateActionsPage';
import EventDaysPage from '@/features/shared/exchanges/EventDaysPage';
import ExchangesPage from '@/features/shared/exchanges/ExchangesPage';
import HolidaysPage from '@/features/shared/exchanges/HolidaysPage';
import KillSwitchPage from '@/features/shared/rms/KillSwitchPage';
import RMSBreachesPage from '@/features/shared/rms/RMSBreachesPage';
import RMSDailyStatsPage from '@/features/shared/rms/RMSDailyStatsPage';
import RMSPage from '@/features/shared/rms/RMSPage';
import RecomputeChargesPage from '@/features/admin/recompute-charges/RecomputeChargesPage';
import RecomputePositionalMtmPage from '@/features/admin/recompute-positional-mtm/RecomputePositionalMtmPage';
import RunEodJobPage from '@/features/admin/run-eod-job/RunEodJobPage';
import SpecialTradingDaysPage from '@/features/shared/exchanges/SpecialTradingDaysPage';
import StockUniversesPage from '@/features/shared/equity-universe/StockUniversesPage';
import StrategyConfigTreePage from '@/features/shared/strategy-config/StrategyConfigTreePage';
import StrategyEnginePage from '@/features/shared/strategy-engine/StrategyEnginePage';
import StrategyPoliciesPage from '@/features/shared/strategy-config/StrategyPoliciesPage';
import SymbolsPage from '@/features/shared/symbols/SymbolsPage';
import SystemConfig from '@/features/admin/system-config/SystemConfig';
import SystemStatus from '@/features/admin/system-status/SystemStatus';
import TradeLogPage from '@/features/shared/trade-log/TradeLogPage';
import TradeTimelinePage from '@/features/shared/trade-log/TradeTimelinePage';

// Analytics
import BrokerPerformanceAnalytics from '@/features/shared/analytics/BrokerPerformance';
import CapitalMarginAnalytics from '@/features/shared/analytics/CapitalMarginAnalytics';
import StrategyAnalytics from '@/features/shared/analytics/StrategyAnalytics';
import TradeAnalytics from '@/features/shared/analytics/TradeAnalytics';

// Market data and terminal
import { DataProvidersPage } from '@/features/market-data/data-providers';
import { LiveFeedPage } from '@/features/market-data/live-feed';
import TerminalPage from '@/features/terminal/TerminalPage';

/**
 * One operator, one Console.
 *
 * The app this was copied from served many users: a portal at the root for
 * each of them and a Console for staff, with routes gated by a permission
 * matrix. Garuda has a single admin who owns every account on it, so there is
 * no portal, no permission gating and no default path to work out -- signing
 * in lands on the Console.
 */
function App() {
  const { initializeConfig } = useConfigStore();
  const { isAuthenticated, isLoading } = useAuthStore();
  const { checkAuthStatus } = useAuth();

  useEffect(() => {
    initializeConfig();
    checkAuthStatus();
  }, [initializeConfig, checkAuthStatus]);

  if (isLoading) {
    return <LoadingScreen />;
  }

  return (
    <Routes>
      <Route element={<AuthLayout />}>
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/console" replace /> : <LoginPage />}
        />
      </Route>

      <Route
        element={
          <ProtectedRoute>
            <ConsoleLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/console" element={<ConsoleDashboard />} />

        {/* Accounts */}
        <Route path="/console/brokers" element={<BrokersPage />} />
        <Route path="/console/broker-config" element={<BrokerConfigPage />} />
        <Route path="/console/broker-instruments" element={<BrokerInstrumentsPage />} />

        {/* Strategy */}
        <Route path="/console/strategy-engine" element={<StrategyEnginePage />} />
        <Route path="/console/strategy-config" element={<StrategyConfigTreePage />} />
        <Route path="/console/strategy-policies" element={<StrategyPoliciesPage />} />
        <Route path="/console/allocation-models" element={<AllocationModelsPage />} />

        {/* Risk */}
        <Route path="/console/rms" element={<RMSPage />} />
        <Route path="/console/rms-breaches" element={<RMSBreachesPage />} />
        <Route path="/console/kill-switch" element={<KillSwitchPage />} />
        <Route path="/console/rms-daily-stats" element={<RMSDailyStatsPage />} />

        {/* Market */}
        <Route path="/console/symbols" element={<SymbolsPage />} />
        <Route path="/console/exchanges" element={<ExchangesPage />} />
        <Route path="/console/holidays" element={<HolidaysPage />} />
        <Route path="/console/event-days" element={<EventDaysPage />} />
        <Route path="/console/special-trading-days" element={<SpecialTradingDaysPage />} />
        <Route path="/console/data-providers" element={<DataProvidersPage />} />
        <Route path="/console/stock-universes" element={<StockUniversesPage />} />

        {/* Operations */}
        <Route path="/console/alerts" element={<ConsoleAlertsPage />} />
        <Route path="/console/audit-logs" element={<AuditLogsPage />} />
        <Route path="/console/trade-log" element={<TradeLogPage />} />
        <Route path="/console/trade-log/:tradeId" element={<TradeTimelinePage />} />
        <Route path="/console/reports" element={<ConsoleReportsPage />} />
        <Route path="/console/system-config" element={<SystemConfig />} />
        <Route path="/console/system-status" element={<SystemStatus />} />
        <Route path="/console/corporate-actions" element={<CorporateActionsPage />} />
        <Route path="/console/recompute-charges" element={<RecomputeChargesPage />} />
        <Route
          path="/console/recompute-positional-mtm"
          element={<RecomputePositionalMtmPage />}
        />
        <Route path="/console/run-eod-job" element={<RunEodJobPage />} />

        {/* Analytics */}
        <Route path="/console/analytics/trades" element={<TradeAnalytics />} />
        <Route path="/console/analytics/strategies" element={<StrategyAnalytics />} />
        <Route path="/console/analytics/capital" element={<CapitalMarginAnalytics />} />
        <Route
          path="/console/analytics/broker-performance"
          element={<BrokerPerformanceAnalytics />}
        />
      </Route>

      <Route
        element={
          <ProtectedRoute>
            <TerminalLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/terminal" element={<TerminalPage />} />
        <Route path="/live-feed" element={<LiveFeedPage />} />
      </Route>

      <Route path="/" element={<Navigate to="/console" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default App;
