// Status pill. Migrated to the Tailwind design system (tokens +  prefix);
// API unchanged.
type Status =
  | 'active'
  | 'inactive'
  | 'pending'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'success'
  | 'warning'
  | 'info'
  | 'logged_in'
  | 'logged_out';

interface StatusBadgeProps {
  status: Status | string;
  label?: string;
  size?: 'sm' | 'lg';
}

// tone keyword → token classes
const toneClasses: Record<string, string> = {
  success: 'bg-success-500/15 text-success-600 dark:text-success-400',
  secondary: 'bg-raised text-ink-soft',
  warning: 'bg-warning-500/15 text-warning-600 dark:text-warning-400',
  danger: 'bg-danger-500/15 text-danger-600 dark:text-danger-400',
  info: 'bg-accent-500/15 text-accent-600 dark:text-accent-400',
  primary: 'bg-primary-500/15 text-primary-700 dark:text-primary-400',
  blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
};

const statusConfig: Record<string, { bg: string; label: string }> = {
  active: { bg: 'success', label: 'Active' },
  inactive: { bg: 'secondary', label: 'Inactive' },
  pending: { bg: 'warning', label: 'Pending' },
  completed: { bg: 'success', label: 'Completed' },
  cancelled: { bg: 'danger', label: 'Cancelled' },
  error: { bg: 'danger', label: 'Error' },
  success: { bg: 'success', label: 'Success' },
  warning: { bg: 'warning', label: 'Warning' },
  info: { bg: 'info', label: 'Info' },
  logged_in: { bg: 'success', label: 'Logged In' },
  logged_out: { bg: 'secondary', label: 'Logged Out' },
  // UPPERCASE = TradeState — fixed app-wide scheme (brand-independent):
  // active=blue, completed=green, cancelled=amber. (lowercase 'active' etc.
  // are entity/login semantics where green = enabled — intentionally different.)
  ACTIVE: { bg: 'blue', label: 'Active' },
  COMPLETED: { bg: 'success', label: 'Completed' },
  CANCELLED: { bg: 'warning', label: 'Cancelled' },
  PENDING: { bg: 'warning', label: 'Pending' },
  REJECTED: { bg: 'danger', label: 'Rejected' },
  CRITICAL: { bg: 'danger', label: 'Critical' },
  WARNING: { bg: 'warning', label: 'Warning' },
  INFO: { bg: 'info', label: 'Info' },
};

const sizeClasses = {
  sm: 'text-[0.6rem] px-1.5 py-0.5',
  lg: 'text-xs px-2 py-1',
  default: 'text-[0.65rem] px-2 py-0.5',
};

const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label, size }) => {
  const config = statusConfig[status] || { bg: 'secondary', label: status };
  const tone = toneClasses[config.bg] ?? toneClasses.secondary;
  const sz = size ? sizeClasses[size] : sizeClasses.default;

  return (
    <span className={`inline-flex items-center rounded-full font-semibold ${tone} ${sz}`}>
      {label || config.label}
    </span>
  );
};

export default StatusBadge;
