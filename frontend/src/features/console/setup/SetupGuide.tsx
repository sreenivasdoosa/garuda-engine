import { Link } from 'react-router-dom';
import {
  BsBank,
  BsBoxes,
  BsBuilding,
  BsCalendarEvent,
  BsCalendarPlus,
  BsCalendarX,
  BsCollection,
  BsCpu,
  BsDiagram3,
  BsFileEarmarkText,
  BsGear,
  BsListUl,
  BsPlug,
  BsShieldCheck,
  BsShieldLock,
  BsSliders,
  BsStopCircle,
  BsTags,
  BsTerminal,
} from 'react-icons/bs';
import type { IconType } from 'react-icons';

/**
 * What to configure, in the order it has to happen.
 *
 * This is the Console's first page because on a fresh install nothing else has
 * anything to show. The order is not a preference: each stage needs the one
 * above it to exist. A strategy cannot pick a strike without a symbol, a
 * symbol has no session without an exchange, and an order cannot be sized
 * without a trading client and a risk limit.
 *
 * Nothing here reports whether a step is done. That would need endpoints most
 * of these pages do not have yet, and a checklist that lies is worse than no
 * checklist -- `garuda check` on the box answers it honestly today.
 */

interface Step {
  to: string;
  label: string;
  icon: IconType;
  blurb: string;
}

interface Stage {
  title: string;
  why: string;
  steps: Step[];
}

const STAGES: Stage[] = [
  {
    title: 'Venues and the calendar',
    why: 'Where you trade and when it is open. Nothing runs until at least one exchange is active — every session check, every staleness check and every square-off time is read from here.',
    steps: [
      {
        to: '/console/exchanges',
        label: 'Exchanges',
        icon: BsBuilding,
        blurb: 'NSE, BSE, MCX. Set the segments, the currency and the trading hours. Start here.',
      },
      {
        to: '/console/holidays',
        label: 'Holidays',
        icon: BsCalendarX,
        blurb: 'Days the exchange is shut. The engine will not place an order on one.',
      },
      {
        to: '/console/special-trading-days',
        label: 'Special Trading Days',
        icon: BsCalendarPlus,
        blurb: 'Sessions that do not follow the usual hours — muhurat, and any one-off.',
      },
      {
        to: '/console/event-days',
        label: 'Event Days',
        icon: BsCalendarEvent,
        blurb: 'Days you would rather the engine stood aside. Results, policy, whatever you decide.',
      },
    ],
  },
  {
    title: 'Instruments and prices',
    why: 'What you can trade, and where the quotes come from. A strategy resolves a strike against this data, so it has to be right before anything is subscribed.',
    steps: [
      {
        to: '/console/symbols',
        label: 'Symbols',
        icon: BsTags,
        blurb: 'The underlyings and their contract specifications — lot size, tick, expiry rules.',
      },
      {
        to: '/console/stock-universes',
        label: 'Stock Universes',
        icon: BsCollection,
        blurb: 'Named baskets a strategy can draw its candidates from.',
      },
      {
        to: '/console/data-providers',
        label: 'Data Providers',
        icon: BsPlug,
        blurb: 'The feeds for quotes and candles, and the order they fail over in.',
      },
    ],
  },
  {
    title: 'Brokers and accounts',
    why: 'Who places the orders. A broker is configured once; a trading client is one account at that broker, and there can be several.',
    steps: [
      {
        to: '/console/broker-config',
        label: 'Broker Config',
        icon: BsGear,
        blurb: 'Per-broker settings and per-exchange enablement. Do this before adding an account.',
      },
      {
        to: '/console/broker-instruments',
        label: 'Broker Instruments',
        icon: BsFileEarmarkText,
        blurb: "The broker's own identifier for each instrument, mapped to yours.",
      },
      {
        to: '/console/brokers',
        label: 'Trading Clients',
        icon: BsBank,
        blurb: 'The accounts the engine trades — yours and your family’s. Signing one in is a deliberate act, every session.',
      },
    ],
  },
  {
    title: 'Risk, before any order',
    why: 'Every entry and every exit passes the gate. Set the limits before a strategy is live, not after — an unset limit is not a permissive one, it is a gap.',
    steps: [
      {
        to: '/console/rms',
        label: 'RMS Config',
        icon: BsShieldLock,
        blurb: 'Loss caps, position caps, order rates and quote staleness — global, or narrowed to one client, strategy or symbol.',
      },
      {
        to: '/console/kill-switch',
        label: 'Kill Switches',
        icon: BsStopCircle,
        blurb: 'The stop. Worth knowing where it is before you need it.',
      },
    ],
  },
  {
    title: 'Strategy',
    why: 'Strategies here are configuration, not code. Build the pieces, then subscribe an account to one.',
    steps: [
      {
        to: '/console/allocation-models',
        label: 'Allocation Models',
        icon: BsDiagram3,
        blurb: 'How capital is divided across strategies and legs.',
      },
      {
        to: '/console/strategy-policies',
        label: 'Strategy Policies',
        icon: BsShieldCheck,
        blurb: 'Reusable entry, exit and trailing templates to point a strategy at.',
      },
      {
        to: '/console/strategy-config',
        label: 'Strategy Config',
        icon: BsSliders,
        blurb: 'The strategy itself: legs, strike selection, rules, tranches, hedges.',
      },
      {
        to: '/console/strategy-engine',
        label: 'Strategy Engine',
        icon: BsCpu,
        blurb: 'Subscribe a trading client to a strategy. Paper or live is a property of the subscription, so the same strategy can run both at once.',
      },
    ],
  },
  {
    title: 'Once it is running',
    why: 'Where to watch from, and where to look when something is off.',
    steps: [
      {
        to: '/terminal',
        label: 'Terminal',
        icon: BsTerminal,
        blurb: 'The live grid: positions, orders and P&L across every account, full screen.',
      },
      {
        to: '/console/trade-log',
        label: 'Trade Log',
        icon: BsListUl,
        blurb: 'Every trade the engine took, and why.',
      },
      {
        to: '/console/rms-breaches',
        label: 'RMS Breaches',
        icon: BsShieldLock,
        blurb: 'What the risk gate stopped, when, and which rule stopped it.',
      },
      {
        to: '/console/system-status',
        label: 'System Status',
        icon: BsBoxes,
        blurb: 'Feeds, sessions, schedulers — what is up and what is not.',
      },
    ],
  },
];

const SetupGuide: React.FC = () => (
  <div className="mx-auto max-w-6xl">
    <header className="mb-9">
      <h1 className="font-display text-3xl font-bold tracking-tight text-ink">Set up the engine</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
        Six stages, in the order they have to happen — each one needs the one above it to exist.
        On a fresh install, work down the list. After that this is a map.
      </p>
    </header>

    <ol className="space-y-10">
      {STAGES.map((stage, i) => (
        <li key={stage.title} className="relative pl-14">
          {/* The number, and the line joining it to the next stage. */}
          <span
            className="absolute left-0 top-0 flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold text-white"
            style={{ background: 'var(--brand-gradient)' }}
          >
            {i + 1}
          </span>
          {i < STAGES.length - 1 && (
            <span
              aria-hidden
              className="absolute left-5 top-12 bottom-[-2.5rem] w-px bg-hairline"
            />
          )}

          <h2 className="font-display text-lg font-semibold text-ink">{stage.title}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-soft">{stage.why}</p>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {stage.steps.map(({ to, label, icon: Icon, blurb }) => (
              <Link
                key={to}
                to={to}
                className="group flex gap-3 rounded-xl border border-hairline bg-card p-3.5 no-underline transition-colors hover:border-primary-500/50 hover:bg-raised"
              >
                <span
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: 'var(--brand-gradient-soft)' }}
                >
                  <Icon size={15} className="text-primary-300" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink group-hover:text-primary-300">
                    {label}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-ink-faint">{blurb}</span>
                </span>
              </Link>
            ))}
          </div>
        </li>
      ))}
    </ol>

    <p className="mt-12 border-t border-hairline pt-5 text-xs text-ink-faint">
      Whether the engine can actually trade is a question the engine answers, not this page. Run{' '}
      <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink-soft">garuda check</code>{' '}
      on the box, or open{' '}
      <Link to="/console/system-status" className="text-primary-400 no-underline hover:underline">
        System Status
      </Link>
      .
    </p>
  </div>
);

export default SetupGuide;
