import { rangeSwitchHref, txCursor } from './chain-txs-shape';
import { CHAIN_TXS, RANGE, SELLER_PAGE } from './constants';
import { parseRange, type RangeDays } from './range';

const NODE_ID = /^[0-9a-f]{64}$/;
const PAGE = /^[1-9]\d{0,5}$/;

export interface SellerPageState {
  days: RangeDays;
  models: number;
  daily: number;
  before: string | null;
}

export const sellerNodeId = (value: string) =>
  NODE_ID.test(value) ? value : null;

export const pageNumber = (value: unknown) =>
  typeof value === 'string' && PAGE.test(value) ? Number(value) : 1;

export function pageOf<T>(items: readonly T[], requested: number) {
  const pages = Math.max(1, Math.ceil(items.length / SELLER_PAGE.rowsPerPage));
  const page = Math.min(requested, pages);
  const start = (page - 1) * SELLER_PAGE.rowsPerPage;
  return {
    rows: items.slice(start, start + SELLER_PAGE.rowsPerPage),
    page,
    pages,
  };
}

export function sellerPageState(
  params: Record<string, string | string[] | undefined>,
): SellerPageState {
  return {
    days: parseRange(params[RANGE.param]),
    models: pageNumber(params[SELLER_PAGE.modelsParam]),
    daily: pageNumber(params[SELLER_PAGE.dailyParam]),
    before: txCursor(params[CHAIN_TXS.param]),
  };
}

export function sellerHref(nodeId: string, state: SellerPageState) {
  const params = new URLSearchParams();
  if (state.days !== RANGE.defaultDays)
    params.set(RANGE.param, String(state.days));
  if (state.models > 1)
    params.set(SELLER_PAGE.modelsParam, String(state.models));
  if (state.daily > 1) params.set(SELLER_PAGE.dailyParam, String(state.daily));
  if (state.before) params.set(CHAIN_TXS.param, state.before);
  const query = params.toString();
  return `${SELLER_PAGE.path}/${nodeId}${query ? `?${query}` : ''}`;
}

export function rangeHref(pathname: string, search: string, days: RangeDays) {
  const prefix = `${SELLER_PAGE.path}/`;
  const nodeId = pathname.startsWith(prefix)
    ? sellerNodeId(pathname.slice(prefix.length))
    : null;
  if (!nodeId) return rangeSwitchHref(search, days);
  const params = Object.fromEntries(new URLSearchParams(search));
  return sellerHref(nodeId, { ...sellerPageState(params), days });
}
