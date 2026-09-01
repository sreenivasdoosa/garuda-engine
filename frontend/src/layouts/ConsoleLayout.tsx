import { Outlet } from 'react-router-dom';
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
import { HelpDrawer } from '@/components/common';
import { useUIStore } from '@/store/uiStore';
import { allHelpContent } from '@/data/help';
import clsx from 'clsx';

interface NavItem {
  path: string;
  label: string;
  icon: IconType;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const ConsoleLayout: React.FC = () => {
  const { sidebarCollapsed } = useUIStore();

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

  // Every section shows. One operator with every right, so there is nothing
  // to filter and nothing to gate a route by beyond being signed in -- which
  // `ProtectedRoute` already does.
  const sidebarSections: SidebarSection[] = allSections;

  return (
    <div className="app-wrapper admin-layout">
      <Header />
      <Sidebar sections={sidebarSections} />
      <main
        className={clsx('main-content', {
          'sidebar-collapsed': sidebarCollapsed,
        })}
      >
        <Outlet />
      </main>
      <HelpDrawer contentMap={allHelpContent} />
    </div>
  );
};

export default ConsoleLayout;
