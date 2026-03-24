/**
 * Pagination utilities
 */

export interface PaginationInfo {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevUrl: string | null;
  nextUrl: string | null;
  pages: number[];
}

/**
 * Calculate pagination info
 */
export function paginate(
  totalItems: number,
  currentPage: number,
  pageSize: number,
  baseUrl: string,
  maxVisible = 10
): PaginationInfo {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(1, currentPage), totalPages);

  // Calculate visible page numbers
  let start = Math.max(1, page - Math.floor(maxVisible / 2));
  const end = Math.min(totalPages, start + maxVisible - 1);
  start = Math.max(1, end - maxVisible + 1);

  const pages: number[] = [];
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  const buildPageUrl = (p: number): string => {
    if (p === 1) return baseUrl;
    const separator = baseUrl.endsWith('/') ? '' : '/';
    return `${baseUrl}${separator}page/${p}/`;
  };

  return {
    currentPage: page,
    totalPages,
    totalItems,
    pageSize,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    prevUrl: page > 1 ? buildPageUrl(page - 1) : null,
    nextUrl: page < totalPages ? buildPageUrl(page + 1) : null,
    pages,
  };
}
