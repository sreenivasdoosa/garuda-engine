import { HTMLAttributes, ReactNode } from 'react'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean
  padded?: boolean
}
export function Card({ hover = false, padded = true, className = '', ...props }: CardProps) {
  return (
    <div
      className={`bg-card border border-hairline rounded-card ${padded ? 'p-5 ' : ''}${
        hover ? 'transition-all hover:border-primary-500/40 hover:shadow-card dark:hover:shadow-card-dark ' : ''
      }${className}`}
      {...props}
    />
  )
}

export interface StatCardProps {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  tone?: 'default' | 'success' | 'warning' | 'danger'
  className?: string
}
const toneText = {
  default: 'text-ink',
  success: 'text-success-500',
  warning: 'text-warning-500',
  danger: 'text-danger-500',
} as const
export function StatCard({ label, value, hint, icon, tone = 'default', className = '' }: StatCardProps) {
  return (
    <Card className={className}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</p>
          <p className={`mt-1 text-2xl font-display font-bold tabular-nums ${toneText[tone]}`}>{value}</p>
          {hint && <p className="mt-1 text-xs text-ink-soft">{hint}</p>}
        </div>
        {icon && <div className="shrink-0 text-primary-400">{icon}</div>}
      </div>
    </Card>
  )
}
