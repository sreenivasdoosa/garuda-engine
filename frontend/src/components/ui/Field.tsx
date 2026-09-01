import { InputHTMLAttributes, LabelHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

const focus =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-app'
const controlBase = `w-full bg-card text-ink border border-hairline rounded-control px-3 py-2 text-sm placeholder:text-ink-faint focus:border-primary-500/60 disabled:opacity-50 transition-colors ${focus}`

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className = '',
}: {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`space-y-1 ${className}`}>
      {label && (
        <label htmlFor={htmlFor} className="block text-xs font-medium text-ink-soft">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-danger-500">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-faint">{hint}</p>
      ) : null}
    </div>
  )
}

export const Label = (p: LabelHTMLAttributes<HTMLLabelElement>) => <label {...p} />
export const Input = ({ className = '', ...p }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={`${controlBase} ${className}`} {...p} />
)
export const Textarea = ({ className = '', ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={`${controlBase} ${className}`} {...p} />
)
export const Select = ({ className = '', ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={`${controlBase} cursor-pointer ${className}`} {...p} />
)
export function Checkbox({ label, className = '', ...p }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className={`inline-flex items-center gap-2 cursor-pointer text-sm text-ink ${className}`}>
      <input type="checkbox" className="h-4 w-4 rounded border-hairline accent-primary-500" {...p} />
      {label}
    </label>
  )
}
