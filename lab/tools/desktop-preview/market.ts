// Preview-only market helpers: buyer totals, the median reference and the closest free model.
import { PREVIEW } from './constants';

const scale = PREVIEW.priceScale;

export function buyerTotal(net: number) {
  return (
    Math.round(
      ((net * (PREVIEW.bpsScale + PREVIEW.networkFeeBps)) / PREVIEW.bpsScale) *
        scale,
    ) / scale
  );
}

export function marketMedian(prices: readonly number[]) {
  if (prices.length < PREVIEW.medianMinOffers) return null;
  const sorted = [...prices].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return Math.round(median * scale) / scale;
}

const family = (name: string) => name.toLowerCase().match(/^[a-z]+/)?.[0] ?? '';
const size = (name: string) => {
  const match = name.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

export function similarFreeModel<T extends { name: string; free: boolean }>(
  models: readonly T[],
  current: string,
) {
  const target = size(current);
  const distance = (item: T) => Math.abs(size(item.name) - target);
  const free = models.filter((item) => item.free);
  const same = free.filter((item) => family(item.name) === family(current));
  return [...(same.length ? same : free)].sort(
    (left, right) => distance(left) - distance(right),
  )[0];
}
