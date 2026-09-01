import { ReactNode } from 'react'

export interface PageHeaderProps {
  title: ReactNode
  eyebrow?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}
export function PageHeader({ title, eyebrow, subtitle, actions, className = '' }: PageHeaderProps) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        {eyebrow && <p className="mb-1.5 text-xs font-bold uppercase tracking-[0.15em] text-primary-400">{eyebrow}</p>}
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
