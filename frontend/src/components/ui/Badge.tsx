import { ReactNode } from 'react'

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'blue'
// Light mode uses the darker 600/700 text shades (≥4.5:1 on the pale tint
// bg); dark mode flips to the bright 400s. Matches the outline-button rule.
// `blue` is a FIXED status color (blue ALWAYS = active/live, like green =
// success) — unlike `primary`, it does not follow the brand flavor, so it
// stays blue whatever the primary colour is.
const tones: Record<Tone, string> = {
  neutral: 'bg-raised text-ink-soft',
  primary: 'bg-primary-500/15 text-primary-700 dark:text-primary-400',
  blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  success: 'bg-success-500/15 text-success-500 dark:text-success-400',
  warning: 'bg-warning-500/15 text-warning-700 dark:text-warning-400',
  danger: 'bg-danger-500/15 text-danger-600 dark:text-danger-400',
  info: 'bg-accent-500/15 text-accent-600 dark:text-accent-400',
}
export function Badge({
  tone = 'neutral',
  children,
  className = '',
  icon,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
  icon?: ReactNode
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}>
      {icon}
      {children}
    </span>
  )
}

// Map the app's status vocabulary → tone. Extend StatusKind for the domain.
export type StatusKind =
  | 'done' | 'complete' | 'compliant' | 'accepted'
  | 'partial' | 'in_progress' | 'review' | 'pending'
  | 'missing' | 'overdue' | 'prohibited' | 'failed' | 'not_started'
const statusTone: Record<StatusKind, Tone> = {
  done: 'success', complete: 'success', compliant: 'success', accepted: 'success',
  partial: 'warning', in_progress: 'warning', review: 'warning', pending: 'warning',
  missing: 'danger', overdue: 'danger', prohibited: 'danger', failed: 'danger', not_started: 'neutral',
}
export function StatusPill({
  kind,
  label,
  icon,
  className = '',
}: {
  kind: StatusKind
  label: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return <Badge tone={statusTone[kind] ?? 'neutral'} icon={icon} className={className}>{label}</Badge>
}
