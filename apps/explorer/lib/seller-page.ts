import { ALL_TIME, PAGES } from './constants';
import type { OfferPriceHistory } from './offer-price-history';
import { modelFromSlug } from './offers';
import type { RangeDays } from './range';

const NODE_ID = /^[0-9a-f]{64}$/;

export const sellerNodeId = (value: string) =>
  NODE_ID.test(value) ? value : null;

export function pagePath(pathname: string) {
  const modelPrefix = `${PAGES.models}/`;
  if (
    pathname.startsWith(modelPrefix) &&
    modelFromSlug(pathname.slice(modelPrefix.length))
  )
    return pathname;
  const prefix = `${PAGES.sellers}/`;
  const nodeId = pathname.startsWith(prefix)
    ? sellerNodeId(pathname.slice(prefix.length))
    : null;
  const page = Object.values(PAGES).find((path) => path === pathname);
  return nodeId ? pathname : (page ?? PAGES.network);
}

type HistoryAvailability = Pick<
  OfferPriceHistory,
  'hasPeriods' | 'truncated' | 'error'
>;

export async function missingSellerHistory(
  selected: HistoryAvailability,
  days: RangeDays,
  readRetained: () => Promise<HistoryAvailability>,
) {
  const completeAndEmpty = (history: HistoryAvailability) =>
    !history.hasPeriods && !history.error && !history.truncated;
  if (!completeAndEmpty(selected)) return false;
  return days === ALL_TIME || completeAndEmpty(await readRetained());
}
