import { FiSun, FiMoon } from 'react-icons/fi'
import { useDarkMode } from '@/hooks/useDarkMode'

// Light/dark toggle. Token-styled so it reads correctly in both modes and any
// brand flavor. Safe to mount inside the (still-Bootstrap) app header.
export default function ThemeToggle({ className = '' }: { className?: string }) {
  const { isDark, toggle } = useDarkMode()
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Light mode' : 'Dark mode'}
      className={`inline-flex items-center justify-center p-2 rounded-control bg-card border border-hairline text-ink hover:bg-raised transition-colors cursor-pointer ${className}`}
    >
      {isDark ? <FiSun className="w-5 h-5 text-warning-400" /> : <FiMoon className="w-5 h-5" />}
    </button>
  )
}
