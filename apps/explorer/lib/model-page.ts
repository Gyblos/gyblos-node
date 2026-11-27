import type { ModelSide, NetworkDay } from './collector-shape';
import {
  COVERAGE_NOTES,
  COVERAGE_STATES,
  DISPLAY,
  RANGE,
  UNITS,
} from './constants';
import type { OfferedModel, Seller } from './discovery';
import { latencyMs } from './format';
import type { Latency } from './latency';
import type { OfferPriceSeries } from './offer-price-history';
import { uptimeRatio } from './offers';

export interface ModelNow {
  sellers: number;
  free: number;
  paid: number;
  minInput: bigint | null;
  minOutput: bigint | null;
  context: number;
  weekUptime: number | null;
}
export interface PriceSpread {
  min: bigint;
  median: bigint;
  max: bigint;
}
export interface PriceDay {
  day: string;
  sellers: number | null;
  input: PriceSpread | null;
  output: PriceSpread | null;
}

const isFree = (offer: OfferedModel) =>
  offer.pricing.inputAtomicPerMtok === '0' &&
  offer.pricing.outputAtomicPerMtok === '0';
const lowest = (values: bigint[]) =>
  values.length
    ? values.reduce((low, value) => (value < low ? value : low))
    : null;
const isoDay = (at: number) =>
  new Date(at).toISOString().slice(0, RANGE.dayPrecision);

export function modelNow(
  offers: readonly { seller: Seller; offer: OfferedModel }[],
): ModelNow {
  const paid = offers.filter(({ offer }) => !isFree(offer));
  const uptimes = offers.flatMap(({ seller }) => {
    const ratio = uptimeRatio(seller, DISPLAY.weekWindow);
    return ratio === undefined ? [] : [ratio];
  });
  return {
    sellers: new Set(offers.map(({ seller }) => seller.nodeId)).size,
    free: offers.length - paid.length,
    paid: paid.length,
    minInput: lowest(
      paid.map(({ offer }) => BigInt(offer.pricing.inputAtomicPerMtok)),
    ),
    minOutput: lowest(
      paid.map(({ offer }) => BigInt(offer.pricing.outputAtomicPerMtok)),
    ),
    context: Math.max(0, ...offers.map(({ offer }) => offer.contextTokens)),
    weekUptime: uptimes.length
      ? uptimes.reduce((sum, ratio) => sum + ratio, 0) / uptimes.length
      : null,
  };
}

export function demandPoints(days: readonly NetworkDay[], modelId: string) {
  return days.map((row) => {
    const listed = row.demand.find((entry) => entry.modelId === modelId);
    const partial =
      row.coverage && row.coverage !== COVERAGE_STATES.FINAL
        ? COVERAGE_NOTES[row.coverage]
        : undefined;
    if (listed)
      return { day: row.day, value: listed.requests, detail: partial };
    const whole =
      row.coverage === COVERAGE_STATES.FINAL &&
      row.demand.length < DISPLAY.demandModelsPerDay;
    if (whole) return { day: row.day, value: 0 };
    const note =
      partial ??
      (row.coverage
        ? `not among the day’s top ${DISPLAY.demandModelsPerDay}`
        : COVERAGE_NOTES[COVERAGE_STATES.UNKNOWN]);
    return { day: row.day, value: null, detail: note };
  });
}

export function latencyBars(latency: Latency | null | undefined) {
  if (!latency?.samples) return [];
  const last = latency.bucketsMs.at(-1);
  const bars = latency.counts.map((count, index) => {
    const bound = latency.bucketsMs[index];
    const label =
      bound === undefined
        ? `> ${latencyMs(last ?? null).slice(2)}`
        : latencyMs(bound);
    return { label, count, share: count / latency.samples };
  });
  const first = bars.findIndex((bar) => bar.count > 0);
  if (first < 0) return [];
  const end =
    bars.length - [...bars].reverse().findIndex((bar) => bar.count > 0);
  return bars.slice(first, end);
}

function spread(values: bigint[]): PriceSpread | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const middle = Math.floor((sorted.length - 1) / 2);
  const low = sorted[middle] ?? 0n;
  const high = sorted[sorted.length - 1 - middle] ?? low;
  return {
    min: sorted[0] ?? 0n,
    median: (low + high) / 2n,
    max: sorted.at(-1) ?? 0n,
  };
}

function latestBySeller(
  series: readonly OfferPriceSeries[],
  day: number,
  end: number,
) {
  const latest = new Map<string, OfferPriceSeries['points'][number]>();
  for (const item of series)
    for (const point of item.points) {
      const current = latest.get(item.nodeId);
      if (
        point.at < end &&
        point.end > day &&
        (!current || point.at >= current.at)
      )
        latest.set(item.nodeId, point);
    }
  return [...latest.values()];
}

export function priceDays(
  series: readonly OfferPriceSeries[],
  from: number,
  to: number,
  knownFrom = from,
): PriceDay[] {
  const result: PriceDay[] = [];
  const start = Math.floor(from / UNITS.msPerDay) * UNITS.msPerDay;
  for (let day = start; day < to; day += UNITS.msPerDay) {
    const end = day + UNITS.msPerDay;
    if (end <= knownFrom) {
      result.push({
        day: isoDay(day),
        sellers: null,
        input: null,
        output: null,
      });
      continue;
    }
    const quotes = latestBySeller(series, day, end);
    const paid = quotes.filter((quote) => quote.input || quote.output);
    result.push({
      day: isoDay(day),
      sellers: quotes.length,
      input: spread(paid.map((quote) => quote.input)),
      output: spread(paid.map((quote) => quote.output)),
    });
  }
  return result;
}

export const sideTokens = (side: ModelSide | null) =>
  side
    ? [
        { label: 'Input', count: side.tokens.input },
        { label: 'Output', count: side.tokens.output },
        { label: 'Reasoning', count: side.tokens.reasoning },
      ]
    : [];
