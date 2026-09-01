import { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'

export function Table({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto rounded-card border border-hairline">
      <table className={`w-full text-left text-sm ${className}`}>{children}</table>
    </div>
  )
}
export const THead = ({ children }: { children: ReactNode }) => (
  <thead className="bg-raised text-xs uppercase tracking-wide text-ink-faint">{children}</thead>
)
export const TBody = ({ children }: { children: ReactNode }) => (
  <tbody className="divide-y divide-hairline">{children}</tbody>
)
export const TR = ({ className = '', ...p }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={`hover:bg-raised/50 transition-colors ${className}`} {...p} />
)
export const TH = ({ className = '', ...p }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th className={`px-4 py-2.5 font-semibold ${className}`} {...p} />
)
export const TD = ({ className = '', ...p }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={`px-4 py-2.5 text-ink ${className}`} {...p} />
)
