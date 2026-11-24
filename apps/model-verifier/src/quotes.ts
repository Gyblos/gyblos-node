import { randomBytes } from 'node:crypto';

import { acceptControlQuote } from '@gyblos/core/control-quotes';
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_METHODS,
  CONTROL_VERSION,
  PUBLIC_RECORD_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import { parseControlQuery } from '@gyblos/protocol/control-requests';
import type { matchControlResponse } from '@gyblos/protocol/control-response';
import type {
  ControlQuery,
  PublicModelV2,
  SignedPublicV2,
} from '@gyblos/protocol/control-types';
import { ControlError } from '@gyblos/protocol/control-validation';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import {
  catalogDigestV2,
  validatePublicV2Time,
  verifyPublicV2,
} from '@gyblos/protocol/public-v2';

import {
  FREE_ATOMIC,
  MODEL_VERIFIER_CODES,
  ModelVerifierError,
} from './constants';

export type QuoteExchange = (
  query: ControlQuery,
) => Promise<ReturnType<typeof matchControlResponse>>;
export interface SellerTrust {
  owner: string;
  nodeId: string;
  relayAllowed: (origin: string) => boolean;
}
const requestId = () =>
  randomBytes(CONTROL_LIMITS.requestIdBytes).toString('hex');
const isFree = (model: PublicModelV2) =>
  model.pricing.inputAtomicPerMtok === FREE_ATOMIC &&
  model.pricing.outputAtomicPerMtok === FREE_ATOMIC &&
  model.reasoning.includes(REASONING_LEVELS.OFF);

export const invalidSeller = () =>
  new ModelVerifierError(MODEL_VERIFIER_CODES.INVALID_SELLER);

async function freeListing(
  exchange: QuoteExchange,
  trust: SellerTrust,
  modelId: string,
  now: () => number,
) {
  const answer = await exchange({
    version: CONTROL_VERSION,
    requestId: requestId(),
    method: CONTROL_METHODS.CATALOG,
    params: {},
  });
  if (answer.method !== CONTROL_METHODS.CATALOG) throw invalidSeller();
  const record = await verifyPublicV2(answer.catalog, {
    ...trust,
    now: now(),
  });
  validatePublicV2Time(record, now());
  if (record.kind !== PUBLIC_RECORD_KINDS.CATALOG) throw invalidSeller();
  const listing = record.models.find(
    (model) => model.modelId === modelId && isFree(model),
  );
  if (!listing)
    throw new ModelVerifierError(MODEL_VERIFIER_CODES.NO_FREE_OFFER);
  const catalog: SignedPublicV2 = {
    record,
    signature: answer.catalog.signature,
  };
  return { listing, catalog, catalogDigest: await catalogDigestV2(record) };
}

async function freeQuote(
  exchange: QuoteExchange,
  trust: SellerTrust,
  offered: Awaited<ReturnType<typeof freeListing>>,
  buyer: { address: string; nodeId: string },
  maxTokens: number,
  now: () => number,
) {
  const { listing, catalog, catalogDigest } = offered;
  const query = parseControlQuery({
    version: CONTROL_VERSION,
    requestId: requestId(),
    method: CONTROL_METHODS.OFFER,
    params: {
      buyer: buyer.address,
      buyerNodeId: buyer.nodeId,
      selection: selectionOf(listing),
      reasoning: REASONING_LEVELS.OFF,
      maxTokens,
      maxAtomic: FREE_ATOMIC,
      priceCeilings: {
        inputAtomicPerMtok: FREE_ATOMIC,
        outputAtomicPerMtok: FREE_ATOMIC,
      },
      network: listing.pricing.network,
      asset: listing.pricing.asset,
      catalogDigest,
    },
  });
  const offer = await exchange(query);
  if (offer.method !== CONTROL_METHODS.OFFER) throw invalidSeller();
  const accepted = await acceptControlQuote(offer.offer, query, {
    ...trust,
    now: now(),
    catalog,
  });
  validateOfferV2Time(accepted, now());
  return offer.offer;
}

const selectionOf = (listing: PublicModelV2) => ({
  modelId: listing.modelId,
  variant: listing.variant,
  quantization: listing.quantization,
});

const sameSelection = (
  left: ReturnType<typeof selectionOf>,
  right: ReturnType<typeof selectionOf>,
) =>
  left.modelId === right.modelId &&
  left.variant === right.variant &&
  left.quantization === right.quantization;

export function createFreeQuoter(
  exchange: QuoteExchange,
  trust: SellerTrust,
  modelId: string,
  buyer: { address: string; nodeId: string },
  now: () => number = Date.now,
) {
  let offered: Awaited<ReturnType<typeof freeListing>> | undefined;
  async function refresh() {
    const next = await freeListing(exchange, trust, modelId, now);
    if (
      offered &&
      !sameSelection(selectionOf(offered.listing), selectionOf(next.listing))
    )
      throw new ModelVerifierError(MODEL_VERIFIER_CODES.NO_FREE_OFFER);
    offered = next;
    return next;
  }
  return {
    async open() {
      return selectionOf((await refresh()).listing);
    },
    async quote(maxTokens: number) {
      const current =
        offered && now() < offered.catalog.record.expiresAt
          ? offered
          : await refresh();
      try {
        return await freeQuote(exchange, trust, current, buyer, maxTokens, now);
      } catch (error) {
        if (!(
          error instanceof ControlError && error.code === CONTROL_CODES.STALE
        ))
          throw error;
        return freeQuote(
          exchange,
          trust,
          await refresh(),
          buyer,
          maxTokens,
          now,
        );
      }
    },
  };
}
