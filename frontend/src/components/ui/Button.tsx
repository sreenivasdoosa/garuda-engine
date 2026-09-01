import { ButtonHTMLAttributes, forwardRef } from 'react'

// Token-driven, theme-aware button. `primary` is the flavor gradient — use one
// per screen, sparingly. All classes carry the migration `` prefix.
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning'
type Size = 'sm' | 'md'
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const focus =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-app'
const base = `inline-flex items-center justify-center gap-2 font-medium rounded-control transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap ${focus}`

const variants: Record<Variant, string> = {
  primary: 'bg-accent-gradient text-white shadow-glow hover:shadow-glow-lg hover:brightness-110',
  secondary: 'bg-transparent text-ink border border-hairline hover:bg-raised hover:border-primary-500/50',
  ghost: 'bg-transparent text-ink-soft hover:text-ink hover:bg-raised',
  danger: 'bg-danger-600 text-white hover:bg-danger-700',
  warning: 'bg-warning-500 text-black hover:bg-warning-600',
}
const sizes: Record<Size, string> = { sm: 'text-xs px-3 py-1.5', md: 'text-sm px-4 py-2' }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className = '', type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props} />
})
