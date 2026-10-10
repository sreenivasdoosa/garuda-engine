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
  BsPersonBadge,
  BsPlayCircle,
  BsPlug,
  BsShieldCheck,
  BsShieldLock,
  BsSignpostSplit,
  BsSliders,
  BsSignpost2,
  BsStopCircle,
  BsTags,
} from 'react-icons/bs';
import type { IconType } from 'react-icons';

export interface NavItem {
  path: string;
  label: string;
  icon: IconType;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/**
 * The Console's pages, by section.
 *
 * One list, read by the top bar, the section row under it, and anything else
 * that needs to know what pages exist. No item carries a permission key: one
 * operator holds every right, so what is reachable is decided here and in the
 * route table, where the decision is visible.
 *
 * Both orderings are the order you configure things in, not the alphabet:
 * venues before instruments, instruments before brokers, brokers before
 * accounts, accounts and risk before any strategy. `SetupGuide` walks the
 * same path with the reasons attached.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Setup',
    items: [{ path: '/console', label: 'Setup Guide', icon: BsSignpost2 }],
  },
  {
    title: 'Market',
    items: [
      { path: '/console/exchanges', label: 'Exchanges', icon: BsBuilding },
      { path: '/console/holidays', label: 'Holidays', icon: BsCalendarX },
      { path: '/console/special-trading-days', label: 'Special Trading Days', icon: BsCalendarPlus },
      { path: '/console/event-days', label: 'Event Days', icon: BsCalendarEvent },
      { path: '/console/symbols', label: 'Symbols', icon: BsTags },
      { path: '/console/stock-universes', label: 'Stock Universes', icon: BsCollection },
      { path: '/console/data-providers', label: 'Data Providers', icon: BsPlug },
    ],
  },
  {
    title: 'Accounts',
    items: [
      { path: '/console/trading-clients', label: 'Trading Clients', icon: BsPersonBadge },
      { path: '/console/brokers', label: 'Brokers', icon: BsBank },
      { path: '/console/broker-config', label: 'Broker Config', icon: BsGear },
      { path: '/console/broker-instruments', label: 'Broker Instruments', icon: BsFileEarmarkText },
    ],
  },
  {
    title: 'Risk',
    items: [
      { path: '/console/rms', label: 'RMS Config', icon: BsShieldLock },
      { path: '/console/kill-switch', label: 'Kill Switches', icon: BsStopCircle },
      { path: '/console/rms-breaches', label: 'RMS Breaches', icon: BsExclamationTriangle },
      { path: '/console/rms-daily-stats', label: 'RMS Daily Stats', icon: BsCardChecklist },
    ],
  },
  {
    title: 'Strategy',
    items: [
      { path: '/console/allocation-models', label: 'Allocation Models', icon: BsDiagram3 },
      { path: '/console/strategy-policies', label: 'Strategy Policies', icon: BsShieldCheck },
      { path: '/console/strategy-config', label: 'Strategy Config', icon: BsSliders },
      { path: '/console/strategy-engine', label: 'Strategy Engine', icon: BsCpu },
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
      { path: '/console/corporate-actions', label: 'Corporate Actions', icon: BsSignpostSplit },
      { path: '/console/recompute-charges', label: 'Recompute Charges', icon: BsCalculator },
      { path: '/console/recompute-positional-mtm', label: 'Recompute Positional MTM', icon: BsArrowRepeat },
      { path: '/console/run-eod-job', label: 'Run EOD Job', icon: BsPlayCircle },
      { path: '/console/system-status', label: 'System Status', icon: BsActivity },
      { path: '/console/system-config', label: 'System Config', icon: BsGear },
    ],
  },
];

/** Every page, flattened — for the jump-to palette and for `sectionFor`. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/**
 * Which section a path belongs to.
 *
 * Longest matching path wins, so `/console/analytics/trades` resolves to
 * Analytics rather than to Overview's `/console`, which is a prefix of every
 * Console route.
 */
export const sectionFor = (pathname: string): NavSection => {
  let best: { section: NavSection; length: number } | null = null;
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      const hit = pathname === item.path || pathname.startsWith(item.path + '/');
      if (hit && (!best || item.path.length > best.length)) {
        best = { section, length: item.path.length };
      }
    }
  }
  return best?.section ?? NAV_SECTIONS[0];
};
