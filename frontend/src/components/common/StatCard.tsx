import { IconType } from 'react-icons';
import clsx from 'clsx';
import { formatIndianNumber } from '@/utils/formatters';

// Compact console/admin stat card. Migrated to the Tailwind design system
// (tokens +  prefix); API unchanged so all 13 consumers re-skin for free.

interface StatCardProps {
  title: string;
  value: string | number;
  icon?: IconType;
  iconBg?: string;
  change?: number;
  changeLabel?: string;
  prefix?: string;
  suffix?: string;
  loading?: boolean;
  subtitle?: string;
}

// Map the legacy iconBg keyword → token tint + text classes.
const iconTones: Record<string, string> = {
  primary: 'bg-primary-500/15 text-primary-500',
  success: 'bg-success-500/15 text-success-500',
  danger: 'bg-danger-500/15 text-danger-500',
  warning: 'bg-warning-500/15 text-warning-600 dark:text-warning-400',
  info: 'bg-accent-500/15 text-accent-500',
  secondary: 'bg-raised text-ink-soft',
};

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  icon: Icon,
  iconBg = 'primary',
  change,
  changeLabel,
  prefix,
  suffix,
  loading = false,
  subtitle,
}) => {
  const isPositive = change !== undefined && change >= 0;

  return (
    <div className="mb-3 h-full rounded-card border border-hairline bg-card p-2">
      <div className="flex items-start gap-2">
        {Icon && (
          <div className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded', iconTones[iconBg] ?? iconTones.primary)}>
            <Icon size={16} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="mb-0 text-[0.65rem] font-semibold uppercase tracking-wide text-ink-faint">{title}</p>
          {loading ? (
            <div className="mt-1 h-4 w-16 animate-pulse rounded bg-raised" />
          ) : (
            <>
              <h3 className="mb-0 font-display text-lg font-bold tabular-nums text-ink">
                {prefix}
                {typeof value === 'number' ? formatIndianNumber(value) : value}
                {suffix}
              </h3>
              {subtitle && <small className="text-[0.65rem] text-ink-soft">{subtitle}</small>}
              {change !== undefined && (
                <span className={clsx('ml-1 text-[0.65rem] font-semibold', isPositive ? 'text-success-500' : 'text-danger-500')}>
                  {isPositive ? '+' : ''}
                  {change}%{changeLabel && ` ${changeLabel}`}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default StatCard;
