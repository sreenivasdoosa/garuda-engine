import { ReactNode, useState } from 'react'

// Minimal hover/focus tooltip. Inverted (ink bubble) so it reads on any surface.
export function Tooltip({
  label,
  children,
  placement = 'bottom',
  className = '',
}: {
  label: ReactNode
  children: ReactNode
  placement?: 'top' | 'bottom'
  className?: string
}) {
  const [show, setShow] = useState(false)
  const pos = placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
  return (
    <span
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {children}
      {show && label && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute left-1/2 z-[1200] -translate-x-1/2 whitespace-nowrap rounded-control bg-ink px-2 py-1 text-xs font-medium text-app shadow-card ${pos}`}
        >
          {label}
        </span>
      )}
    </span>
  )
}
