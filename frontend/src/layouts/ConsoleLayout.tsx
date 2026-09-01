import { useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Forbidden } from '@/components/errors/ErrorPages';
import {
  BsActivity,
  BsArrowRepeat,
  BsBank,
  BsBell,
  BsBuilding,
  BsCalculator,
  BsCalendarEvent,
  BsCalendarPlus,
  BsCalendarX,
  BsCardChecklist,
  BsClockHistory,
  BsCollection,
  BsCpu,
  BsCurrencyRupee,
  BsDiagram3,
  BsExclamationTriangle,
  BsFileEarmarkBarGraph,
  BsFileEarmarkText,
  BsGear,
  BsGraphUp,
  BsLightning,
  BsListUl,
  BsPlayCircle,
  BsPlug,
  BsShieldCheck,
  BsShieldLock,
  BsSignpostSplit,
  BsSliders,
  BsSpeedometer2,
  BsStopCircle,
  BsTags,
} from 'react-icons/bs';
import { IconType } from 'react-icons';

import Header from '@/components/layout/Header';
import Sidebar, { SidebarSection } from '@/components/layout/Sidebar';
import { HelpDrawer, LicenseActivationBanner } from '@/components/common';
import { useUIStore } from '@/store/uiStore';
import { usePermissions, type PermissionCheck } from '@/hooks/usePermissions';
import { allHelpContent } from '@/data/help';
import clsx from 'clsx';

// Extended item type with permission key
interface NavItem {
  path: string;
  label: string;
  icon: IconType;
  permission?: keyof ReturnType<typeof usePermissions>;
  /** Require admin-level access (isAdmin) on top of any `permission`. For pages whose API hard-requires
   *  admin (e.g. System Status) so they are hidden from a non-admin supervisor, not shown-then-403. */
  adminOnly?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const ConsoleLayout: React.FC = () => {
  const { sidebarCollapsed } = useUIStore();
  const permissions = usePermissions();

  // The Console's sections. One operator with every right, so no item carries
  // a permission key: what an operator may reach is decided by what is in this
  // list and in the route table, where the decision is visible.
  const allSections: NavSection[] = [
    {
      title: 'Overview',
      items: [{ path: '/console', label: 'Dashboard', icon: BsSpeedometer2 }],
    },
    {
      title: 'Accounts',
      items: [
        { path: '/console/brokers', label: 'Trading Clients', icon: BsBank },
        { path: '/console/broker-config', label: 'Broker Config', icon: BsGear },
        { path: '/console/broker-instruments', label: 'Broker Instruments', icon: BsFileEarmarkText },
      ],
    },
    {
      title: 'Strategy',
      items: [
        { path: '/console/strategy-engine', label: 'Strategy Engine', icon: BsCpu },
        { path: '/console/strategy-config', label: 'Strategy Config', icon: BsSliders },
        { path: '/console/strategy-policies', label: 'Strategy Policies', icon: BsShieldCheck },
        { path: '/console/allocation-models', label: 'Allocation Models', icon: BsDiagram3 },
      ],
    },
    {
      title: 'Risk',
      items: [
        { path: '/console/rms', label: 'RMS Config', icon: BsShieldLock },
        { path: '/console/rms-breaches', label: 'RMS Breaches', icon: BsExclamationTriangle },
        { path: '/console/kill-switch', label: 'Kill Switches', icon: BsStopCircle },
        { path: '/console/rms-daily-stats', label: 'RMS Daily Stats', icon: BsCardChecklist },
      ],
    },
    {
      title: 'Market',
      items: [
        { path: '/console/symbols', label: 'Symbols', icon: BsTags },
        { path: '/console/exchanges', label: 'Exchanges', icon: BsBuilding },
        { path: '/console/holidays', label: 'Holidays', icon: BsCalendarX },
        { path: '/console/special-trading-days', label: 'Special Trading Days', icon: BsCalendarPlus },
        { path: '/console/event-days', label: 'Event Days', icon: BsCalendarEvent },
        { path: '/console/data-providers', label: 'Data Providers', icon: BsPlug },
        { path: '/console/stock-universes', label: 'Stock Universes', icon: BsCollection },
      ],
    },
    {
      title: 'Analytics',
      items: [
        { path: '/console/analytics/trades', label: 'Trade Analytics', icon: BsGraphUp },
        { path: '/console/analytics/strategies', label: 'Strategy Performance', icon: BsLightning },
        { path: '/console/analytics/capital', label: 'Capital & Margin', icon: BsCurrencyRupee },
        { path: '/console/analytics/broker-performance', label: 'Broker Performance', icon: BsBank },
      ],
    },
    {
      title: 'Operations',
      items: [
        { path: '/console/trade-log', label: 'Trade Log', icon: BsListUl },
        { path: '/console/alerts', label: 'Alerts', icon: BsBell },
        { path: '/console/reports', label: 'Reports', icon: BsFileEarmarkBarGraph },
        { path: '/console/audit-logs', label: 'Audit Logs', icon: BsClockHistory },
        { path: '/console/system-status', label: 'System Status', icon: BsActivity },
        { path: '/console/system-config', label: 'System Config', icon: BsGear },
        { path: '/console/corporate-actions', label: 'Corporate Actions', icon: BsSignpostSplit },
        { path: '/console/recompute-charges', label: 'Recompute Charges', icon: BsCalculator },
        { path: '/console/recompute-positional-mtm', label: 'Recompute Positional MTM', icon: BsArrowRepeat },
        { path: '/console/run-eod-job', label: 'Run EOD Job', icon: BsPlayCircle },
      ],
    },
  ];

  // Filter sections based on permissions
  const sidebarSections: SidebarSection[] = useMemo(() => {
    return allSections
      .map((section) => {
        // Filter items based on view permission
        const filteredItems = section.items.filter((item) => {
          // Admin-only pages (API hard-requires admin) are hidden from non-admins regardless of any
          // resource right they may hold (e.g. a supervisor with SYSTEM_CONFIG:view).
          if (item.adminOnly && !permissions.isAdmin) return false;

          // Items without permission key are always shown (e.g., Dashboard)
          if (!item.permission) return true;

          // Check if permission exists and has canView
          const perm = permissions[item.permission];
          if (perm && typeof perm === 'object' && 'canView' in perm) {
            return (perm as PermissionCheck).canView;
          }
          return false;
        });

        return {
          title: section.title,
          items: filteredItems,
        };
      })
      // Remove sections with no visible items
      .filter((section) => section.items.length > 0);
  }, [permissions]);

  // Central per-route authorization. The console layout only requires management access, so without
  // this any management-access user (e.g. a Portfolio Manager) could URL-navigate to a page they
  // lack the specific tool right for. We gate the rendered route by the SAME permission its sidebar
  // item declares — find the most specific item matching the current path and check its canView.
  // Unmapped paths (e.g. the /console dashboard root) are always allowed (QUANT-188).
  const location = useLocation();
  const routeAllowed = useMemo(() => {
    const path = location.pathname;
    let match: NavItem | undefined;
    for (const section of allSections) {
      for (const item of section.items) {
        if ((path === item.path || path.startsWith(item.path + '/')) &&
            (!match || item.path.length > match.path.length)) {
          match = item;
        }
      }
    }
    // Admin-only pages: block URL-navigation by a non-admin even if they hold the resource right.
    if (match && match.adminOnly && !permissions.isAdmin) {
      return false;
    }
    if (!match || !match.permission) {
      return true; // dashboard root / unmapped route — no extra gate beyond management access
    }
    const perm = permissions[match.permission];
    if (perm && typeof perm === 'object' && 'canView' in perm) {
      return (perm as PermissionCheck).canView;
    }
    return false;
  }, [location.pathname, permissions]);

  return (
    <div className="app-wrapper admin-layout">
      <Header />
      <Sidebar sections={sidebarSections} />
      <main
        className={clsx('main-content', {
          'sidebar-collapsed': sidebarCollapsed,
        })}
      >
        <LicenseActivationBanner />
        {routeAllowed ? <Outlet /> : <Forbidden />}
      </main>
      <HelpDrawer contentMap={allHelpContent} />
    </div>
  );
};

export default ConsoleLayout;
