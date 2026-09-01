import { Outlet } from 'react-router-dom';
import {
  BsGraphUpArrow,
  BsShieldCheck,
  BsLightningCharge,
  BsBarChartLine,
  BsPeopleFill,
  BsBank2,
  BsGearWideConnected,
  BsSpeedometer2,
} from 'react-icons/bs';
import { useTheme } from '@/context/ThemeContext';
import { BrandLogo } from '@/components/common';

interface BrandTheme {
  background: string;
  glow1: string;
  glow2: string;
  iconBg: string;
  iconColor: string;
  hoverBorder: string;
  accentColor: string;
  buttonGradient: string;
  buttonShadow: string;
}

const brandTheme: BrandTheme = {
  // Blue to purple with a teal accent. One brand, so one theme.
  background: 'linear-gradient(135deg, #0a1628 0%, #0d1f33 30%, #131b3a 60%, #050d1a 100%)',
  glow1: 'radial-gradient(circle, rgba(13, 110, 253, 0.15) 0%, transparent 70%)',
  glow2: 'radial-gradient(circle, rgba(102, 16, 242, 0.12) 0%, transparent 70%)',
  iconBg: 'linear-gradient(135deg, rgba(13, 110, 253, 0.2) 0%, rgba(102, 16, 242, 0.1) 100%)',
  iconColor: '#6ea8fe',
  hoverBorder: 'rgba(13, 110, 253, 0.3)',
  accentColor: '#0d6efd',
  buttonGradient: 'linear-gradient(135deg, #0d6efd 0%, #6610f2 100%)',
  buttonShadow: '0 4px 14px 0 rgba(13, 110, 253, 0.4)',
};

const platformFeatures = [
  {
    icon: BsBank2,
    title: 'Multi-Broker Execution',
    description: 'Connect and trade across multiple brokers simultaneously with unified portfolio tracking.',
  },
  {
    icon: BsGraphUpArrow,
    title: 'Advanced Option Strategies',
    description: 'Institutional-grade option selling strategies with automated entry, exit, and adjustments.',
  },
  {
    icon: BsShieldCheck,
    title: 'Robust Risk Management',
    description: 'Multi-level RMS with daily loss limits, position sizing, kill switches, and real-time breach alerts.',
  },
  {
    icon: BsLightningCharge,
    title: 'Real-Time Live Terminal',
    description: 'Live trading desk with real-time P&L, positions, order book, and strategy performance tracking.',
  },
  {
    icon: BsPeopleFill,
    title: 'Multi-User Platform',
    description: 'Manage multiple users with individual capital allocation, strategy subscriptions, and risk policies.',
  },
  {
    icon: BsBarChartLine,
    title: 'Comprehensive Analytics',
    description: 'Equity curves, Sharpe ratio, strategy-wise performance, capital utilization, and detailed reports.',
  },
  {
    icon: BsGearWideConnected,
    title: 'Multi-Exchange Support',
    description: 'Trade across NSE, BSE, and MCX with exchange-specific configurations and market hour controls.',
  },
  {
    icon: BsSpeedometer2,
    title: 'Automated Operations',
    description: 'Auto broker login, scheduled strategy execution, instrument management, and smart order routing.',
  },
];

const AuthLayout: React.FC = () => {
  const { brandConfig } = useTheme();
  const theme = brandTheme;

  return (
    <div className="auth-layout relative flex min-h-screen overflow-hidden" style={{ background: theme.background }}>
      {/* Decorative glows */}
      <div
        className="absolute"
        style={{ top: '-20%', right: '-10%', width: '500px', height: '500px', background: theme.glow1, borderRadius: '50%', filter: 'blur(60px)' }}
      />
      <div
        className="absolute"
        style={{ bottom: '-20%', left: '-10%', width: '400px', height: '400px', background: theme.glow2, borderRadius: '50%', filter: 'blur(60px)' }}
      />

      <div className="relative z-[1] flex min-h-screen w-full flex-col lg:flex-row">
        {/* Left Panel — Login (~1/3) */}
        <div className="flex flex-col items-center justify-center px-4 py-10 lg:w-1/3">
          <div className="w-full max-w-[400px]">
            <div className="mb-4 text-center">
              <div className="mb-3 flex justify-center">
                <BrandLogo height={48} />
              </div>
              <p className="text-white/75" style={{ fontSize: '1.05rem' }}>
                {brandConfig.tagline}
              </p>
            </div>
            <div
              className="rounded-2xl border border-hairline bg-card/95 p-6 text-ink backdrop-blur-xl"
              style={{ boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.4)' }}
            >
              <Outlet />
            </div>
            <p className="mt-4 text-center text-sm text-white/60">
              Need help? Contact{' '}
              <a href={`mailto:${brandConfig.supportEmail}`} className="text-white/85 hover:underline">
                {brandConfig.supportEmail}
              </a>
            </p>
          </div>
        </div>

        {/* Right Panel — Feature Showcase (~2/3, lg+ only) */}
        <div className="hidden flex-col justify-center py-10 pl-3 pr-10 lg:flex lg:w-2/3">
          <div className="max-w-[820px]">
            <h2 className="mb-2 font-display font-bold text-white" style={{ fontSize: '1.85rem', letterSpacing: '-0.02em' }}>
              Algorithmic Trading Platform
            </h2>
            <p className="mb-4 text-white/60" style={{ fontSize: '1.05rem', lineHeight: 1.6 }}>
              Enterprise-grade infrastructure for automated trading — from strategy execution to risk management, everything you
              need to run a professional trading desk.
            </p>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {platformFeatures.map((feature, index) => (
                <div
                  key={index}
                  className="flex h-full gap-3 rounded-xl border p-3 transition-all"
                  style={{ background: 'rgba(255, 255, 255, 0.06)', borderColor: 'rgba(255, 255, 255, 0.08)' }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                    e.currentTarget.style.borderColor = theme.hoverBorder;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                  }}
                >
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]"
                    style={{ background: theme.iconBg }}
                  >
                    <feature.icon size={20} style={{ color: theme.iconColor }} />
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-white" style={{ fontSize: '0.925rem' }}>
                      {feature.title}
                    </div>
                    <div className="text-white/55" style={{ fontSize: '0.825rem', lineHeight: 1.5 }}>
                      {feature.description}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-4 pt-3" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
              {['NSE', 'BSE', 'MCX'].map((exchange) => (
                <span
                  key={exchange}
                  className="px-3 py-1 text-white/60"
                  style={{ background: 'rgba(255, 255, 255, 0.06)', borderRadius: '20px', fontSize: '0.8rem', fontWeight: 500, letterSpacing: '0.05em' }}
                >
                  {exchange}
                </span>
              ))}
              <span className="self-center text-white/40" style={{ fontSize: '0.8rem' }}>
                Equity &middot; Futures &middot; Options &middot; Commodity
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AuthLayout;

export { brandTheme };
export type { BrandTheme };
