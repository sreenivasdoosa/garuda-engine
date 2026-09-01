import { useEffect, useState } from 'react'

// Light/dark axis for the Tailwind design system. The mode is the `dark` class
// on <html> (independent of the brand flavor's `data-theme`). Persisted to
// localStorage('theme'); the boot script in index.html applies it before paint
// to avoid a flash. This hook mirrors the class so multiple mount points
// (header toggle, preview) stay in sync.
const STORAGE_KEY = 'theme'

export function useDarkMode() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'))

  // Keep in sync if the class is changed elsewhere (another toggle instance).
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setIsDark(el.classList.contains('dark')))
    obs.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  const setDark = (next: boolean) => {
    const el = document.documentElement
    if (next) {
      el.classList.add('dark')
      localStorage.setItem(STORAGE_KEY, 'dark')
    } else {
      el.classList.remove('dark')
      localStorage.setItem(STORAGE_KEY, 'light')
    }
  }

  const toggle = () => setDark(!document.documentElement.classList.contains('dark'))

  return { isDark, toggle, setDark }
}
