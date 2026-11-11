// Evaluates live quote policy over caller-owned snapshots; never generates inference, reserves slots or pays.
import { canonicalJson } from '@gyblos/protocol';
import {
  CONTROL_AVAILABILITY,
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_PAID_ALPN,
  CONTROL_RECORD_VERSION,
  PUBLIC_RECORD_KINDS,
  type ControlMeteringMode,
  type ReasoningLevel,
} from '@gyblos/protocol/constants';
import {
  controlRequestDigest,
  parseOfferQuery,
} from '@gyblos/protocol/control-requests';
import type {
  InferenceOfferV2,
  ModelSelection,
  OfferQuery,
  PublicCatalogV2,
  PublicModelV2,
  SignedOfferV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import {
  controlFail,
  controlInteger,
} from '@gyblos/protocol/control-validation';
import type {
  EngineCapabilities,
  EngineDescription,
} from '@gyblos/protocol/engine';
import {
  parseOfferV2,
  signOfferV2,
  verifyOfferV2,
} from '@gyblos/protocol/offer-v2';
import { catalogDigestV2, verifyPublicV2 } from '@gyblos/protocol/public-v2';
import type { Signer } from '@gyblos/protocol/signing';

export interface QuoteModel {
  selection: ModelSelection;
  model: EngineDescription;
  capabilities: EngineCapabilities;
  reasoning: readonly ReasoningLevel[];
  meteringMode: ControlMeteringMode;
  // The longest answer the offer serves per request; unset, the context alone bounds it.
  maxOutputTokens?: number;
}
export interface QuoteReadiness {
  generation: number;
  busy: boolean;
  observedAt: number;
  validUntil: number;
}
export interface QuoteContext {
  catalog: SignedPublicV2;
  owner: string;
  nodeId: string;
  remoteNodeId: string;
  payTo: string;
  feePayer: string;
  authorizer: string;
  endpoint: InferenceOfferV2['endpoint'];
  relayOnly: boolean;
  models: readonly QuoteModel[];
  now: () => number;
  readiness: () => QuoteReadiness;
  signal?: AbortSignal;
}
// The one definition of two selections naming the same listed model: exact canonical equality.
export function sameSelection(left: ModelSelection, right: ModelSelection) {
  return canonicalJson(left) === canonicalJson(right);
}
function checkPricing(
  query: OfferQuery,
  model: PublicModelV2,
  maxAtomic: string,
) {
  const prices = model.pricing;
  if (
    query.params.network !== prices.network ||
    query.params.asset !== prices.asset ||
    BigInt(prices.inputAtomicPerMtok) >
      BigInt(query.params.priceCeilings.inputAtomicPerMtok) ||
    BigInt(prices.outputAtomicPerMtok) >
      BigInt(query.params.priceCeilings.outputAtomicPerMtok)
  )
    return controlFail(CONTROL_CODES.POLICY);
  const free =
    BigInt(prices.inputAtomicPerMtok) === 0n &&
    BigInt(prices.outputAtomicPerMtok) === 0n;
  if (
    (free && maxAtomic !== '0') ||
    (!free && BigInt(maxAtomic) === 0n) ||
    BigInt(maxAtomic) > BigInt(query.params.maxAtomic)
  )
    return controlFail(CONTROL_CODES.POLICY);
}
function selectedModel(query: OfferQuery, catalog: PublicCatalogV2) {
  const model = catalog.models.find((item) =>
    sameSelection(query.params.selection, {
      modelId: item.modelId,
      variant: item.variant,
      quantization: item.quantization,
    }),
  );
  if (!model) return controlFail(CONTROL_CODES.MODEL);
  if (!model.reasoning.includes(query.params.reasoning))
    return controlFail(CONTROL_CODES.LEVEL);
  if (query.params.maxTokens > model.contextTokens)
    return controlFail(CONTROL_CODES.POLICY);
  return model;
}
async function trustedCatalog(
  context: Pick<QuoteContext, 'catalog' | 'owner' | 'nodeId'>,
  now: number,
) {
  const catalog = await verifyPublicV2(context.catalog, {
    owner: context.owner,
    nodeId: context.nodeId,
    now,
  });
  if (catalog.kind !== PUBLIC_RECORD_KINDS.CATALOG) return controlFail();
  return catalog;
}
function checkReadiness(
  context: QuoteContext,
  state: QuoteReadiness,
  now: number,
) {
  if (context.signal?.aborted) return controlFail(CONTROL_CODES.CANCELLED);
  controlInteger(state.generation);
  controlInteger(state.observedAt);
  controlInteger(state.validUntil);
  if (typeof state.busy !== 'boolean') return controlFail();
  if (state.busy) return controlFail(CONTROL_CODES.BUSY);
  if (state.observedAt > now || state.validUntil <= now)
    return controlFail(CONTROL_CODES.EXPIRED);
}
async function buildQuote(
  query: OfferQuery,
  context: QuoteContext,
  state: QuoteReadiness,
  catalog: PublicCatalogV2,
  now: number,
): Promise<InferenceOfferV2> {
  const digest = await catalogDigestV2(catalog);
  if (digest !== query.params.catalogDigest)
    return controlFail(CONTROL_CODES.STALE);
  const listed = selectedModel(query, catalog);
  const mapped = context.models.find((item) =>
    sameSelection(item.selection, query.params.selection),
  );
  if (!mapped) return controlFail(CONTROL_CODES.MODEL);
  if (
    mapped.model.contextTokens !== listed.contextTokens ||
    mapped.model.contextTokens < query.params.maxTokens ||
    (mapped.maxOutputTokens !== undefined &&
      query.params.maxTokens > mapped.maxOutputTokens)
  )
    return controlFail(CONTROL_CODES.POLICY);
  if (!mapped.reasoning.includes(query.params.reasoning))
    return controlFail(CONTROL_CODES.LEVEL);
  const free =
    BigInt(listed.pricing.inputAtomicPerMtok) === 0n &&
    BigInt(listed.pricing.outputAtomicPerMtok) === 0n;
  const maxAtomic = free ? '0' : query.params.maxAtomic;
  checkPricing(query, listed, maxAtomic);
  // Paid payout may be the owner but must differ from transaction signing keys.
  if (!free && [context.feePayer, context.authorizer].includes(context.payTo))
    return controlFail(CONTROL_CODES.POLICY);
  return parseOfferV2({
    schemaVersion: CONTROL_RECORD_VERSION,
    protocol: CONTROL_PAID_ALPN,
    owner: context.owner,
    nodeId: context.nodeId,
    buyer: query.params.buyer,
    buyerNodeId: query.params.buyerNodeId,
    requestId: query.requestId,
    requestDigest: await controlRequestDigest(query),
    catalogDigest: digest,
    selection: query.params.selection,
    reasoning: query.params.reasoning,
    network: query.params.network,
    mint: query.params.asset,
    payTo: context.payTo,
    feePayer: context.feePayer,
    authorizer: context.authorizer,
    issuedAt: now,
    expiresAt: Math.min(
      now + CONTROL_LIMITS.quoteLifetimeMs,
      catalog.expiresAt,
      state.validUntil,
    ),
    endpoint: context.endpoint,
    relayOnly: context.relayOnly,
    prices: {
      inputAtomicPerMtok: listed.pricing.inputAtomicPerMtok,
      outputAtomicPerMtok: listed.pricing.outputAtomicPerMtok,
    },
    maxAtomic,
    maxTokens: query.params.maxTokens,
    model: mapped.model,
    capabilities: mapped.capabilities,
    meteringMode: mapped.meteringMode,
    availability: { state: CONTROL_AVAILABILITY, observedAt: state.observedAt },
  });
}
// Copies only contract fields so later canonical comparison sees validated values.
function readReadiness(context: QuoteContext): QuoteReadiness {
  const current = context.readiness();
  return {
    generation: current.generation,
    busy: current.busy,
    observedAt: current.observedAt,
    validUntil: current.validUntil,
  };
}
// Returns undefined for a noncanonical caller catalog instead of an untyped canonicalJson error.
function catalogSnapshot(catalog: unknown): string | undefined {
  try {
    return canonicalJson(catalog);
  } catch {
    return undefined;
  }
}
function unchangedReadiness(
  context: QuoteContext,
  initial: QuoteReadiness,
  now: number,
) {
  const current = readReadiness(context);
  checkReadiness(context, current, now);
  if (canonicalJson(current) !== canonicalJson(initial))
    return controlFail(CONTROL_CODES.STALE);
}
export async function createControlQuote(
  value: unknown,
  context: QuoteContext,
  signer: Signer,
): Promise<SignedOfferV2> {
  const query = parseOfferQuery(value, context.remoteNodeId);
  const now = controlInteger(context.now());
  const initialCatalog = catalogSnapshot(context.catalog) ?? controlFail();
  const catalog = await trustedCatalog(context, now);
  // Selection refusal precedes availability observations, signing and all runtime work.
  selectedModel(query, catalog);
  const mapped = context.models.find((item) =>
    sameSelection(item.selection, query.params.selection),
  );
  if (!mapped) return controlFail(CONTROL_CODES.MODEL);
  if (!mapped.reasoning.includes(query.params.reasoning))
    return controlFail(CONTROL_CODES.LEVEL);
  const state = readReadiness(context);
  checkReadiness(context, state, now);
  const offer = await buildQuote(query, context, state, catalog, now);
  unchangedReadiness(context, state, controlInteger(context.now()));
  // Capture signed data, recheck after asynchronous signing, and never publish a cancelled/stale result.
  const signed = await signOfferV2(offer, signer);
  const finishedAt = controlInteger(context.now());
  unchangedReadiness(context, state, finishedAt);
  if (
    finishedAt >= offer.expiresAt ||
    catalogSnapshot(context.catalog) !== initialCatalog
  )
    return controlFail(CONTROL_CODES.STALE);
  return signed;
}
export async function acceptControlQuote(
  value: unknown,
  request: unknown,
  trust: {
    owner: string;
    nodeId: string;
    now: number;
    catalog: SignedPublicV2;
    relayAllowed: (origin: string) => boolean;
  },
): Promise<InferenceOfferV2> {
  const query = parseOfferQuery(request);
  const offer = await verifyOfferV2(value, trust);
  const catalog = await trustedCatalog(trust, trust.now);
  if (
    offer.requestId !== query.requestId ||
    offer.requestDigest !== (await controlRequestDigest(query)) ||
    offer.buyer !== query.params.buyer ||
    offer.buyerNodeId !== query.params.buyerNodeId ||
    offer.catalogDigest !== query.params.catalogDigest ||
    offer.catalogDigest !== (await catalogDigestV2(catalog)) ||
    !sameSelection(offer.selection, query.params.selection) ||
    offer.reasoning !== query.params.reasoning ||
    offer.maxTokens !== query.params.maxTokens ||
    offer.network !== query.params.network ||
    offer.mint !== query.params.asset ||
    offer.expiresAt > catalog.expiresAt
  )
    return controlFail(CONTROL_CODES.POLICY);
  const model = selectedModel(query, catalog);
  checkPricing(query, model, offer.maxAtomic);
  if (
    offer.prices.inputAtomicPerMtok !== model.pricing.inputAtomicPerMtok ||
    offer.prices.outputAtomicPerMtok !== model.pricing.outputAtomicPerMtok ||
    offer.model.contextTokens < offer.maxTokens ||
    offer.model.contextTokens !== model.contextTokens
  )
    return controlFail(CONTROL_CODES.POLICY);
  if (offer.endpoint.relayUrl && !trust.relayAllowed(offer.endpoint.relayUrl))
    return controlFail(CONTROL_CODES.POLICY);
  return offer;
}
