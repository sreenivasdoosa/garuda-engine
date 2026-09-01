import { ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { FiX } from 'react-icons/fi'
import { IconButton } from './IconButton'

// Right-side slide-over panel (replaces react-bootstrap Offcanvas). Portalled to
// <body>, closes on backdrop click / Escape, locks body scroll. Token-driven.
// Slides in/out: stays mounted through the exit transition, then unmounts.
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  width = '500px',
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
}) {
  // `render` keeps the node mounted through the close animation; `closing`
  // swaps the enter keyframes for the exit ones. The enter animation plays on
  // mount (CSS @keyframes, defined in tailwind.css) — no paint-timing juggling.
  const [render, setRender] = useState(open)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (open) {
      setRender(true)
      setClosing(false)
      return
    }
    if (!render) return
    setClosing(true)
    const t = setTimeout(() => {
      setRender(false)
      setClosing(false)
    }, 280)
    return () => clearTimeout(t)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

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

  if (!render) return null

  return createPortal(
    <>
      <div
        className={`fixed inset-0 z-[1055] bg-black/40 ${closing ? 'rb-backdrop-out' : 'rb-backdrop-in'}`}
        onClick={onClose}
      />
      <aside
        className={`fixed right-0 top-0 z-[1060] flex h-full w-full flex-col border-l border-hairline bg-card text-ink shadow-card-dark ${closing ? 'rb-drawer-out' : 'rb-drawer-in'}`}
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
      >
        {title && (
          <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
            <div className="min-w-0 font-display text-base font-semibold text-ink">{title}</div>
            <IconButton aria-label="Close" onClick={onClose}>
              <FiX className="h-5 w-5" />
            </IconButton>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="border-t border-hairline px-4 py-3">{footer}</div>}
      </aside>
    </>,
    document.body,
  )
}
