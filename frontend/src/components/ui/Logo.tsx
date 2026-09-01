import { ReactNode } from 'react'
import { FiShield } from 'react-icons/fi'

// Brand mark: gradient rounded-square + icon, optional wordmark. Pass a custom
// `wordmark` node per brand, or a real brand image via `src` (from ThemeContext
// brandConfig) once layouts are migrated.
type Size = 'sm' | 'md' | 'lg'
export interface LogoProps {
  withWordmark?: boolean
  size?: Size
  className?: string
  wordmark?: ReactNode
  src?: string
  alt?: string
}
const box = { sm: 'h-8 w-8 rounded-xl', md: 'h-11 w-11 rounded-2xl', lg: 'h-14 w-14 rounded-2xl' }
const icon = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-7 h-7' }
const word = { sm: 'text-base', md: 'text-xl', lg: 'text-2xl' }

export function Logo({ withWordmark = false, size = 'md', className = '', wordmark, src, alt = 'Logo' }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      {src ? (
        <img src={src} alt={alt} className={`object-contain ${box[size]}`} />
      ) : (
        <span className={`flex items-center justify-center shrink-0 bg-accent-gradient shadow-glow ${box[size]}`}>
          <FiShield className={`${icon[size]} text-white`} />
        </span>
      )}
      {withWordmark && (
        <span className={`font-display font-bold tracking-tight ${word[size]}`}>
          {wordmark ?? (
            <>
              <span className="text-ink">Garuda</span>
              <span className="bg-accent-gradient bg-clip-text text-transparent"> Algo</span>
            </>
          )}
        </span>
      )}
    </span>
  )
}
