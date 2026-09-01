export type ProgressTone = 'primary' | 'success' | 'warning' | 'danger'
const fills: Record<ProgressTone, string> = {
  primary: 'bg-accent-gradient',
  success: 'bg-success-500',
  warning: 'bg-warning-500',
  danger: 'bg-danger-500',
}
export function ProgressBar({
  value,
  tone,
  autoTone = false,
  className = '',
  height = 'h-1.5',
}: {
  value: number
  tone?: ProgressTone
  autoTone?: boolean
  className?: string
  height?: string
}) {
  const v = Math.max(0, Math.min(100, value))
  const resolved: ProgressTone = tone ?? (autoTone ? (v < 40 ? 'danger' : v < 80 ? 'warning' : 'success') : 'primary')
  return (
    <div className={`w-full ${height} rounded-full bg-raised overflow-hidden ${className}`}>
      <div className={`h-full rounded-full transition-all ${fills[resolved]}`} style={{ width: `${v}%` }} />
    </div>
  )
}
