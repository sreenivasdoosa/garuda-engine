import { PAGE_SIZE_OPTIONS } from '@/types/pagination';

/**
 * Shared server-side pagination control for admin tables. Render it ABOVE the
 * table. Page-size options 10/20/50/100/200 (default 20). Consumes the backend
 * `{ data, pagination }` envelope's pagination fields.
 *
 * Migrated to the Tailwind design system (tokens +  prefix); API unchanged.
 */
interface TablePaginationProps {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  /** Noun shown in "Showing X–Y of Z {label}". Default "items". */
  itemLabel?: string;
  /** Hide while the first load is in flight. */
  loading?: boolean;
}

/** Max page-number buttons to render at once. */
const MAX_PAGE_BUTTONS = 10;

/**
 * Windowed page numbers: up to {@link MAX_PAGE_BUTTONS} consecutive pages centered on the current
 * page, clamped to [1, totalPages]. Shows fewer than the max only when there are fewer total pages
 * (so ≤10 records-per-page-worth → ≤10 buttons). Near the ends the window shifts so a full block of
 * 10 is still shown (e.g. last page → 41…50 rather than just 46…50).
 */
function pageWindow(page: number, totalPages: number): number[] {
  const total = Math.max(totalPages, 1);
  const count = Math.min(MAX_PAGE_BUTTONS, total);
  let start = Math.max(1, page - Math.floor(count / 2));
  const end = Math.min(total, start + count - 1);
  start = Math.max(1, end - count + 1); // shift back so we always show `count` buttons near the end
  const out: number[] = [];
  for (let p = start; p <= end; p++) out.push(p);
  return out;
}

const pageBtn =
  'inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded border border-hairline px-2 text-xs text-ink transition-colors hover:bg-raised disabled:opacity-40 disabled:cursor-not-allowed';
const pageBtnActive = 'border-primary-500 bg-primary-500 text-white hover:bg-primary-600';

export default function TablePagination({
  page,
  pageSize,
  totalCount,
  totalPages,
  onPageChange,
  onPageSizeChange,
  itemLabel = 'items',
  loading = false,
}: TablePaginationProps) {
  const from = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);
  const win = pageWindow(page, Math.max(totalPages, 1));

  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <small className="text-xs text-ink-soft">
        {loading ? 'Loading…' : <>Showing {from}–{to} of {totalCount} {itemLabel}</>}
      </small>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <button type="button" className={pageBtn} disabled={page <= 1} onClick={() => onPageChange(1)} aria-label="First page">
            «
          </button>
          <button type="button" className={pageBtn} disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page">
            ‹
          </button>
          {win[0] > 1 && <span className="px-1 text-xs text-ink-faint">…</span>}
          {win.map((p) => (
            <button
              type="button"
              key={p}
              className={`${pageBtn} ${p === page ? pageBtnActive : ''}`}
              onClick={() => onPageChange(p)}
              aria-current={p === page ? 'page' : undefined}
            >
              {p}
            </button>
          ))}
          {win[win.length - 1] < totalPages && <span className="px-1 text-xs text-ink-faint">…</span>}
          <button type="button" className={pageBtn} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label="Next page">
            ›
          </button>
          <button type="button" className={pageBtn} disabled={page >= totalPages} onClick={() => onPageChange(totalPages)} aria-label="Last page">
            »
          </button>
        </div>

        <select
          className="h-7 w-[110px] rounded border border-hairline bg-card px-2 text-xs text-ink focus-visible:outline-none focus:border-primary-500/60"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          aria-label="Rows per page"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
