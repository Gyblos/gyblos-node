import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import { controlIdentifier } from '@gyblos/protocol/control-validation';

import {
  INDEX_ERRORS,
  INDEX_ROUTES,
  OFFER_HISTORY,
  PERIOD_END_REASONS,
  REGISTRATION,
  type PeriodEndReason,
} from './constants';
import { indexFail, protocolStep } from './errors';
import type { StoredEntry } from './storage';

export interface HistoryOffer {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  contextTokens: number;
  reasoning: string[];
  pricing: {
    inputAtomicPerMtok: string;
    outputAtomicPerMtok: string;
    unit: string;
    network: string;
    asset: string;
  };
}

export interface HistoryPeriod {
  nodeId: string;
  owner: string;
  firstSequence: number;
  lastSequence: number;
  startedAt: number;
  lastPublishedAt: number;
  expiresAt: number;
  endedAt: number | null;
  endReason: PeriodEndReason | null;
  offers: HistoryOffer[];
}

export interface HistoryQuery {
  nodeId: string | null;
  model: string | null;
  since: number;
  limit: number;
}

export interface OfferContent {
  hash: string;
  json: string;
}

export interface OfferHistoryStorage {
  offerHistory(query: HistoryQuery): Promise<HistoryPeriod[]>;
}

const QUERY_KEYS: ReadonlySet<string> = new Set(['node', 'model', 'days']);
const DAYS = /^[1-9][0-9]?$/;

export interface OfferHistoryRequest {
  nodeId: string | null;
  model: string | null;
  days: number;
}

function invalidQuery(): never {
  return indexFail(INDEX_ERRORS.INVALID_QUERY);
}

export async function parseOfferHistoryQuery(
  url: string,
): Promise<OfferHistoryRequest> {
  const params = new URL(url).searchParams;
  for (const key of new Set(params.keys()))
    if (!QUERY_KEYS.has(key) || params.getAll(key).length !== 1) invalidQuery();
  const node = params.get('node');
  const model = params.get('model');
  if ((node === null) === (model === null)) invalidQuery();
  if (node !== null && !REGISTRATION.nodeId.test(node)) invalidQuery();
  const requested = params.get('days');
  if (requested !== null && !DAYS.test(requested)) invalidQuery();
  const days =
    requested === null ? OFFER_HISTORY.defaultDays : Number(requested);
  if (days > OFFER_HISTORY.maxDays) invalidQuery();
  return {
    nodeId: node,
    model:
      model === null
        ? null
        : await protocolStep(
            () => controlIdentifier(model),
            () => INDEX_ERRORS.INVALID_QUERY,
          ),
    days,
  };
}

export const offerHistoryKey = (origin: string, query: OfferHistoryRequest) =>
  `${origin}${INDEX_ROUTES.OFFER_HISTORY}?${query.nodeId === null ? `model=${encodeURIComponent(query.model!)}` : `node=${query.nodeId}`}&days=${query.days}`;

export async function offerHistoryPage(
  storage: OfferHistoryStorage,
  query: OfferHistoryRequest,
  now: number,
  maxBytes: number,
) {
  const since = now - query.days * OFFER_HISTORY.dayMs;
  const periods = await storage.offerHistory({
    nodeId: query.nodeId,
    model: query.model,
    since,
    limit: OFFER_HISTORY.maxPeriods + 1,
  });
  const kept: HistoryPeriod[] = [];
  let size = OFFER_HISTORY.framingBytes;
  for (const period of periods.slice(0, OFFER_HISTORY.maxPeriods)) {
    size += JSON.stringify(period).length + 1;
    if (size > maxBytes) break;
    kept.push(period);
  }
  return JSON.stringify({
    ...(query.nodeId === null
      ? { model: query.model }
      : { node: query.nodeId }),
    days: query.days,
    from: since,
    periods: kept,
    truncated: kept.length < periods.length,
    generatedAt: now,
  });
}

interface MemoryPeriod extends Omit<HistoryPeriod, 'offers'> {
  contentHash: string;
}

const periodEnd = (period: MemoryPeriod) => period.endedAt ?? period.expiresAt;

const newestFirst = (left: MemoryPeriod, right: MemoryPeriod) =>
  right.startedAt - left.startedAt ||
  right.firstSequence - left.firstSequence ||
  (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);

function offersOf(json: string): HistoryOffer[] {
  return (JSON.parse(json) as HistoryOffer[]).map((offer) => ({
    modelId: offer.modelId,
    variant: offer.variant,
    quantization: offer.quantization,
    contextTokens: offer.contextTokens,
    reasoning: offer.reasoning,
    pricing: {
      inputAtomicPerMtok: offer.pricing.inputAtomicPerMtok,
      outputAtomicPerMtok: offer.pricing.outputAtomicPerMtok,
      unit: offer.pricing.unit,
      network: offer.pricing.network,
      asset: offer.pricing.asset,
    },
  }));
}

function close(open: MemoryPeriod, now: number, reason: PeriodEndReason) {
  const lapsed = open.expiresAt <= now;
  open.endedAt = lapsed ? open.expiresAt : Math.max(open.lastPublishedAt, now);
  open.endReason = lapsed ? PERIOD_END_REASONS.EXPIRED : reason;
}

function prunePeriods(
  contents: Map<string, HistoryOffer[]>,
  periods: MemoryPeriod[],
  now: number,
) {
  const cutoff = now - OFFER_HISTORY.retentionDays * OFFER_HISTORY.dayMs;
  const kept = periods.filter((period) => periodEnd(period) > cutoff);
  periods.splice(0, periods.length, ...kept);
  const used = new Set(kept.map((period) => period.contentHash));
  for (const hash of contents.keys())
    if (!used.has(hash)) contents.delete(hash);
}

const periodStart = (
  periods: readonly MemoryPeriod[],
  entry: StoredEntry,
  now: number,
) =>
  Math.min(
    Math.max(
      now,
      ...periods
        .filter((period) => period.nodeId === entry.nodeId)
        .map((period) => period.endedAt ?? now),
    ),
    entry.expiresAt,
  );

export function memoryOfferHistory() {
  const contents = new Map<string, HistoryOffer[]>();
  const periods: MemoryPeriod[] = [];
  function record(entry: StoredEntry) {
    if (entry.kind === PUBLIC_RECORD_KINDS.PRESENCE) return;
    const now = entry.admission.now;
    const open = periods.find(
      (period) => period.nodeId === entry.nodeId && period.endedAt === null,
    );
    if (entry.kind === PUBLIC_RECORD_KINDS.WITHDRAWAL) {
      if (open) close(open, now, PERIOD_END_REASONS.WITHDRAWN);
      return;
    }
    const content = entry.offers;
    if (!content) return;
    if (!contents.has(content.hash))
      contents.set(content.hash, offersOf(content.json));
    if (
      open &&
      open.contentHash === content.hash &&
      open.owner === entry.owner &&
      open.expiresAt > now
    ) {
      open.lastSequence = entry.sequence;
      open.lastPublishedAt = Math.min(
        Math.max(open.lastPublishedAt, now),
        entry.expiresAt,
      );
      open.expiresAt = entry.expiresAt;
      return;
    }
    if (open) close(open, now, PERIOD_END_REASONS.REPLACED);
    const start = periodStart(periods, entry, now);
    periods.push({
      nodeId: entry.nodeId,
      firstSequence: entry.sequence,
      contentHash: content.hash,
      owner: entry.owner,
      startedAt: start,
      lastSequence: entry.sequence,
      lastPublishedAt: start,
      expiresAt: entry.expiresAt,
      endedAt: null,
      endReason: null,
    });
  }
  async function offerHistory(query: HistoryQuery): Promise<HistoryPeriod[]> {
    return periods
      .filter(
        (period) =>
          periodEnd(period) > query.since &&
          (query.nodeId === null || period.nodeId === query.nodeId) &&
          (query.model === null ||
            contents
              .get(period.contentHash)!
              .some((offer) => offer.modelId === query.model)),
      )
      .sort(newestFirst)
      .slice(0, query.limit)
      .map(({ contentHash, ...period }) => ({
        ...period,
        offers: contents
          .get(contentHash)!
          .filter(
            (offer) => query.model === null || offer.modelId === query.model,
          ),
      }));
  }
  return {
    record,
    offerHistory,
    prune: (now: number) => prunePeriods(contents, periods, now),
  };
}
