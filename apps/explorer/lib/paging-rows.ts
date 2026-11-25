import { PAGING } from './constants';

export interface TableSort {
  key: string;
  desc: boolean;
}

export type Sortable = number | bigint | string | null | undefined;

export interface Page<T> {
  rows: T[];
  requested: number;
  page: number;
  pages: number;
  total: number;
  first: number;
  last: number;
}

const compare = (left: Sortable, right: Sortable) => {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  return left < right ? -1 : 1;
};

export function sortedRows<T>(
  rows: readonly T[],
  sort: TableSort | undefined,
  by: Record<string, (row: T) => Sortable>,
): readonly T[] {
  const read = sort ? by[sort.key] : undefined;
  if (!sort || !read) return rows;
  const sign = sort.desc ? -1 : 1;
  return [...rows].sort((left, right) => {
    const first = read(left);
    const second = read(right);
    if (first == null || second == null) return compare(first, second);
    return sign * compare(first, second);
  });
}

export function pageOf<T>(rows: readonly T[], requested: number): Page<T> {
  const pages = Math.max(1, Math.ceil(rows.length / PAGING.rowsPerPage));
  const page = requested >= 1 && requested <= pages ? requested : 1;
  const start = (page - 1) * PAGING.rowsPerPage;
  const shown = rows.slice(start, start + PAGING.rowsPerPage);
  return {
    rows: shown,
    requested,
    page,
    pages,
    total: rows.length,
    first: shown.length ? start + 1 : 0,
    last: start + shown.length,
  };
}
