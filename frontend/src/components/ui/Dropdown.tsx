import { ButtonHTMLAttributes, ReactNode, useEffect, useRef, useState } from 'react'

// Lightweight headless dropdown (no external lib). Opens on trigger click,
// closes on outside-click / Escape / menu-item click. Token-driven + theme-aware.
export function Dropdown({
  trigger,
  children,
  align = 'start',
  menuClassName = '',
  className = '',
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  menuClassName?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className={`relative inline-block ${className}`}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          role="menu"
          onClick={() => setOpen(false)}
          className={`absolute z-[1050] mt-1 min-w-[12rem] rounded-card border border-hairline bg-card py-1 shadow-card dark:shadow-card-dark ${
            align === 'end' ? 'right-0' : 'left-0'
          } ${menuClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function DropdownItem({ className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-raised disabled:opacity-50 ${className}`}
      {...p}
    />
  )
}

export function DropdownDivider() {
  return <div className="my-1 border-t border-hairline" />
}

export function DropdownHeader({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-faint ${className}`}>
      {children}
    </div>
  )
}
