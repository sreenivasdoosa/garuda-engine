import { ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { FiX } from 'react-icons/fi'
import { IconButton } from './IconButton'

// Token-driven modal, portalled to <body>. Closes on backdrop click / Escape;
// locks body scroll while open. z-index sits above the fixed header.
const sizes = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-6xl',
  // Near-full-viewport, for wide data tables that would otherwise scroll
  // horizontally inside a fixed-width dialog.
  '3xl': 'max-w-[95vw]',
} as const

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  tall = false,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: keyof typeof sizes
  /** Reserve near-full viewport height (data-dense dialogs that scroll inside). */
  tall?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={`relative flex w-full flex-col ${sizes[size]} ${
          tall ? 'h-[92vh]' : 'max-h-[90vh]'
        } overflow-hidden rounded-card border border-hairline bg-card shadow-card dark:shadow-card-dark`}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline px-5 py-4">
            <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
            <IconButton aria-label="Close" onClick={onClose}>
              <FiX className="h-5 w-5" />
            </IconButton>
          </div>
        )}
        {/* Header/footer stay pinned; only the body scrolls. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-hairline px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
