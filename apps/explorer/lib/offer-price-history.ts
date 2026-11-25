import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import { PUBLIC_RECORD_LIMITS, V2_PRICING } from '@gyblos/protocol/constants';
import {
  controlArray,
  controlAtomic,
  controlHex,
  controlIdentifier,
  controlInteger,
} from '@gyblos/protocol/control-validation';

import { DISCOVERY_URL } from './config';
import { ALL_TIME, FETCH, OFFER_HISTORY, UNITS } from './constants';
import type { OfferedModel } from './discovery-shape';
import type { RangeDays } from './range';
import { flag, record, SourceShapeError } from './validate';

type Identity = Pick<OfferedModel, 'modelId' | 'variant' | 'quantization'>;
interface HistoryQuery {
  model?: Identity;
  nodeId?: string;
  days: RangeDays;
}
export interface OfferPricePoint {
  at: number;
  end: number;
  input: bigint;
  output: bigint;
}
export interface OfferPriceSeries extends Identity {
  key: string;
  nodeId: string;
  contextTokens: number;
  points: OfferPricePoint[];
}
export interface OfferPriceHistory {
  series: OfferPriceSeries[];
  truncated: boolean;
  error: boolean;
  from: number;
  to: number;
}

async function fetchHistory(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH.timeoutMs),
  });
  if (!response.ok || !response.body)
    throw new SourceShapeError('offer history');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let json = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OFFER_HISTORY.maxBytes) {
        await reader.cancel();
        throw new SourceShapeError('offer history size');
      }
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function addOffer(
  series: Map<string, OfferPriceSeries>,
  raw: unknown,
  nodeId: string,
  at: number,
  end: number,
  selected?: Identity,
) {
  const offer = record(raw, 'offer');
  const pricing = record(offer.pricing, 'offer.pricing');
  if (
    pricing.unit !== V2_PRICING.unit ||
    pricing.network !== DEVNET ||
    pricing.asset !== DEVNET_USDC
  )
    return;
  const modelId = controlIdentifier(offer.modelId);
  const variant =
    offer.variant === null ? null : controlIdentifier(offer.variant);
  const quantization =
    offer.quantization === null ? null : controlIdentifier(offer.quantization);
  if (
    selected &&
    (modelId !== selected.modelId ||
      variant !== selected.variant ||
      quantization !== selected.quantization)
  )
    return;
  const contextTokens = controlInteger(
    offer.contextTokens,
    1,
    PUBLIC_RECORD_LIMITS.maxContextTokens,
  );
  const key = JSON.stringify([
    nodeId,
    modelId,
    variant,
    quantization,
    contextTokens,
  ]);
  const group = series.get(key) ?? {
    key,
    nodeId,
    modelId,
    variant,
    quantization,
    contextTokens,
    points: [],
  };
  group.points.push({
    at,
    end,
    input: BigInt(controlAtomic(pricing.inputAtomicPerMtok)),
    output: BigInt(controlAtomic(pricing.outputAtomicPerMtok)),
  });
  series.set(key, group);
}

export async function getOfferPriceHistory({
  model,
  nodeId,
  days,
}: HistoryQuery): Promise<OfferPriceHistory> {
  try {
    const field = nodeId === undefined ? 'model' : 'node';
    const value =
      nodeId === undefined
        ? controlIdentifier(model?.modelId)
        : controlHex(nodeId);
    const count = days === ALL_TIME ? OFFER_HISTORY.maxDays : days;
    const url = `${DISCOVERY_URL}/offers/history?${field}=${encodeURIComponent(value)}&days=${count}`;
    const source = record(await fetchHistory(url), 'offer history');
    const from = controlInteger(source.from);
    const to = controlInteger(source.generatedAt);
    if (
      source[field] !== value ||
      source.days !== count ||
      to - from !== count * UNITS.msPerDay
    )
      throw new SourceShapeError('offer history window');
    const series = new Map<string, OfferPriceSeries>();
    for (const raw of controlArray(source.periods, OFFER_HISTORY.maxPeriods)) {
      const period = record(raw, 'offer period');
      const seller = controlHex(period.nodeId);
      if (nodeId !== undefined && seller !== nodeId)
        throw new SourceShapeError('offer period node');
      const start = controlInteger(period.startedAt);
      const expires = controlInteger(period.expiresAt, start);
      const ended =
        period.endedAt === null
          ? expires
          : controlInteger(period.endedAt, start, expires);
      const at = Math.max(from, start);
      const end = Math.min(to, ended);
      if (at >= end) continue;
      for (const offer of controlArray(
        period.offers,
        PUBLIC_RECORD_LIMITS.maxModels,
      ))
        addOffer(series, offer, seller, at, end, model);
    }
    for (const group of series.values())
      group.points.sort((left, right) => left.at - right.at);
    return {
      series: [...series.values()],
      truncated: flag(source.truncated, 'history.truncated'),
      error: false,
      from,
      to,
    };
  } catch {
    return { series: [], truncated: false, error: true, from: 0, to: 0 };
  }
}
