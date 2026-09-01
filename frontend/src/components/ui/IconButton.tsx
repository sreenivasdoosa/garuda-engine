import { ButtonHTMLAttributes, forwardRef } from 'react'

type Tone = 'default' | 'danger' | 'primary'
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone
}
const tones: Record<Tone, string> = {
  default: 'text-ink-faint hover:text-ink hover:bg-raised',
  danger: 'text-ink-faint hover:text-danger-500 hover:bg-danger-500/10',
  primary: 'text-ink-faint hover:text-primary-400 hover:bg-primary-500/10',
}
const focus =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-app'

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tone = 'default', className = '', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center justify-center p-1.5 rounded-control transition-colors cursor-pointer disabled:opacity-50 ${focus} ${tones[tone]} ${className}`}
      {...props}
    />
  )
})
