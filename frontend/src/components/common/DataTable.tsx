import { BsInbox } from 'react-icons/bs';
import clsx from 'clsx';
import { Spinner } from '@/components/ui';

// Generic data table. Migrated to the Tailwind design system (tokens + 
// prefix); API unchanged so all 22 consumers work as-is.
export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render?: (item: T, index: number) => React.ReactNode;
  className?: string;
  sortable?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
  keyExtractor: (item: T) => string | number;
  onRowClick?: (item: T) => void;
  rowClassName?: (item: T, index: number) => string;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
  };
  striped?: boolean;
  hover?: boolean;
  size?: 'sm' | 'lg';
  /** Max height for vertical scrolling with sticky header */
  maxHeight?: string;
}

const pageBtn =
  'inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded border border-hairline px-2 text-xs text-ink transition-colors hover:bg-raised disabled:opacity-40 disabled:cursor-not-allowed';
const pageBtnActive = 'border-primary-500 bg-primary-500 text-white hover:bg-primary-600';

function DataTable<T>({
  columns,
  data,
  loading = false,
  emptyMessage = 'No data available',
  keyExtractor,
  onRowClick,
  rowClassName,
  pagination,
  striped = true,
  hover = true,
  size = 'sm',
  maxHeight,
}: DataTableProps<T>) {
  const totalPages = pagination ? Math.ceil(pagination.total / pagination.pageSize) : 0;
  const cellPad = size === 'lg' ? 'px-4 py-3' : 'px-3 py-2';

  const renderPagination = () => {
    if (!pagination || totalPages <= 1) return null;
    const { page, onPageChange } = pagination;

    const startPage = Math.max(1, page - 2);
    const endPage = Math.min(totalPages, page + 2);
    const nums: number[] = [];
    for (let i = startPage; i <= endPage; i++) nums.push(i);

    return (
      <div className="mt-2 flex items-center justify-between gap-2">
        <small className="text-[0.7rem] text-ink-soft">
          Showing {(page - 1) * pagination.pageSize + 1} to {Math.min(page * pagination.pageSize, pagination.total)} of{' '}
          {pagination.total} entries
        </small>
        <div className="flex items-center gap-1">
          <button type="button" className={pageBtn} disabled={page === 1} onClick={() => onPageChange(1)} aria-label="First page">
            «
          </button>
          <button type="button" className={pageBtn} disabled={page === 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page">
            ‹
          </button>
          {startPage > 1 && (
            <>
              <button type="button" className={pageBtn} onClick={() => onPageChange(1)}>
                1
              </button>
              {startPage > 2 && <span className="px-1 text-xs text-ink-faint">…</span>}
            </>
          )}
          {nums.map((i) => (
            <button
              type="button"
              key={i}
              className={`${pageBtn} ${i === page ? pageBtnActive : ''}`}
              onClick={() => onPageChange(i)}
              aria-current={i === page ? 'page' : undefined}
            >
              {i}
            </button>
          ))}
          {endPage < totalPages && (
            <>
              {endPage < totalPages - 1 && <span className="px-1 text-xs text-ink-faint">…</span>}
              <button type="button" className={pageBtn} onClick={() => onPageChange(totalPages)}>
                {totalPages}
              </button>
            </>
          )}
          <button type="button" className={pageBtn} disabled={page === totalPages} onClick={() => onPageChange(page + 1)} aria-label="Next page">
            ›
          </button>
          <button type="button" className={pageBtn} disabled={page === totalPages} onClick={() => onPageChange(totalPages)} aria-label="Last page">
            »
          </button>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="py-4 text-center text-primary-500">
        <Spinner size="sm" />
        <p className="mb-0 mt-2 text-xs text-ink-soft">Loading...</p>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <BsInbox className="mb-2 text-ink-faint" style={{ fontSize: '2rem' }} />
        <p className="mb-1 text-sm font-medium text-ink">No Data</p>
        <p className="mb-0 text-xs text-ink-soft">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <>
      <div
        className="overflow-x-auto rounded-card border border-hairline"
        style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}
      >
        <table className="w-full text-left">
          <thead className={clsx('bg-raised', maxHeight && 'sticky top-0 z-[1]')}>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={clsx(cellPad, 'text-[0.65rem] font-semibold uppercase tracking-wide text-ink-faint', col.className)}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {data.map((item, index) => (
              <tr
                key={keyExtractor(item)}
                onClick={() => onRowClick?.(item)}
                className={clsx(
                  striped && 'even:bg-raised/30',
                  hover && 'hover:bg-raised/60',
                  onRowClick && 'cursor-pointer',
                  'transition-colors',
                  rowClassName?.(item, index),
                )}
              >
                {columns.map((col) => (
                  <td key={col.key} className={clsx(cellPad, 'text-xs text-ink', col.className)}>
                    {col.render ? col.render(item, index) : ((item as Record<string, unknown>)[col.key] as React.ReactNode)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {renderPagination()}
    </>
  );
}

export default DataTable;
