import { Outlet } from 'react-router-dom';
import {
  BsBank2,
  BsBoxes,
  BsDiagram3,
  BsHddNetwork,
  BsShieldLock,
  BsSliders,
} from 'react-icons/bs';

import { BrandLogo } from '@/components/common';

/**
 * The way in.
 *
 * Deliberately plain: a dark field, the mark, one card, and a short account of
 * what this engine is. The app this was copied from sold itself here, because
 * it had to -- it was a platform many people signed up to. This one is
 * installed by the person who signs in, so the page has nothing to sell and
 * says what the thing does instead.
 *
 * **One operator, many accounts.** That is the distinction the copy has to get
 * right: not multi-user, multi-*client*. One person runs the engine and it
 * trades a set of broker accounts on their behalf.
 */

/** Shared by the page inside the card, so the two agree on their accents. */
export const authTheme = {
  accent: '#6366f1',
  accentSoft: 'rgba(99, 102, 241, 0.14)',
  ring: 'rgba(99, 102, 241, 0.35)',
};

const capabilities = [
  {
    icon: BsBank2,
    title: 'Many brokers, one engine',
    body: 'Zerodha today; the adapter contract is what makes the next one an afternoon rather than a rewrite.',
  },
  {
    icon: BsBoxes,
    title: 'Many accounts, one operator',
    body: 'Every trading client is yours — your own and your family’s. No sign-ups, no tenants, no roles.',
  },
  {
    icon: BsDiagram3,
    title: 'Strategies as configuration',
    body: 'Legs, strikes, rules and tranches are rows you edit, not classes someone deploys.',
  },
  {
    icon: BsShieldLock,
    title: 'Risk in front of every order',
    body: 'Entries and exits both pass the gate, and an exit is only ever stopped by what the exchange would refuse anyway.',
  },
  {
    icon: BsSliders,
    title: 'Paper beside live',
    body: 'Paper is a property of a subscription, so one strategy runs both ways at once off the same signals.',
  },
  {
    icon: BsHddNetwork,
    title: 'Yours, on your machine',
    body: 'Self-hosted, PostgreSQL, no telemetry and nothing phoning home. AGPL-3.0.',
  },
];

const AuthLayout: React.FC = () => {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#080b14] text-white">
      {/* A quiet grid, and two soft lights behind it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse 90% 70% at 50% 0%, #000 40%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 90% 70% at 50% 0%, #000 40%, transparent 100%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full blur-[110px]"
        style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.30) 0%, transparent 70%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-52 -right-24 h-[460px] w-[460px] rounded-full blur-[110px]"
        style={{ background: 'radial-gradient(circle, rgba(56,189,248,0.18) 0%, transparent 70%)' }}
      />

      <div className="relative z-[1] mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-10">
        <header className="flex items-center justify-between">
          <BrandLogo height={34} className="text-white" />
          <a
            href="https://github.com/sreenivasdoosa/garuda-engine"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-white/45 transition-colors hover:text-white/80"
          >
            Source
          </a>
        </header>

        <main className="flex flex-1 flex-col items-center justify-center gap-14 py-12 lg:flex-row lg:items-center lg:gap-20">
          {/* What it is. */}
          <section className="w-full max-w-xl">
            <p
              className="mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium tracking-wide"
              style={{ borderColor: authTheme.ring, color: '#c7d2fe', background: authTheme.accentSoft }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: authTheme.accent }} />
              Self-hosted algorithmic trading
            </p>
            <h1 className="font-display text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-5xl">
              One desk.
              <br />
              <span
                className="bg-clip-text text-transparent"
                style={{ backgroundImage: 'linear-gradient(100deg, #38bdf8, #6366f1 45%, #a855f7)' }}
              >
                Every account you run.
              </span>
            </h1>
            <p className="mt-5 max-w-lg text-[1.05rem] leading-relaxed text-white/55">
              Garuda trades options, futures and equities across your broker accounts — on NSE, BSE
              and MCX — from strategies you configure rather than code. You are the only person who
              signs in; the accounts it trades are all yours.
            </p>

            <div className="mt-9 grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
              {capabilities.map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex gap-3">
                  <span
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: authTheme.accentSoft }}
                  >
                    <Icon size={15} style={{ color: '#a5b4fc' }} />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-white/90">{title}</h3>
                    <p className="mt-1 text-[0.82rem] leading-relaxed text-white/45">{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* The way in. */}
          <section className="w-full max-w-[380px] shrink-0">
            <div
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-7 backdrop-blur-xl"
              style={{ boxShadow: '0 30px 80px -30px rgba(0,0,0,0.9)' }}
            >
              <Outlet />
            </div>
          </section>
        </main>

        <footer className="flex flex-col items-center justify-between gap-2 border-t border-white/[0.06] pt-6 text-xs text-white/30 sm:flex-row">
          <span>Garuda Engine · AGPL-3.0</span>
          <span>Runs where you put it. Nothing leaves the machine.</span>
        </footer>
      </div>
    </div>
  );
};

export default AuthLayout;
