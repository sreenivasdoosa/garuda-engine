/**
 * Shared types/constants for server-side paginated admin tables. The backend
 * returns the envelope `{ data, pagination }` (see BaseV2Servlet.buildPageEnvelope).
 */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200];
export const DEFAULT_PAGE_SIZE = 20;
