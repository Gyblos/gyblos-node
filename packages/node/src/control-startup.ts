// Builds the seller's public control snapshot from cached observations, never from live engine calls.
// The catalog lists exactly the offers listed at signing time, each mapped to its warmed engine.
import { createSignableMessage, type KeyPairSigner } from '@solana/kit';

import { DEVNET } from '@gyblos/config';
import {
  CONTROL_RECORD_VERSION,
  DATA_RETENTION,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
  V2_PRICING,
} from '@gyblos/protocol/constants';
import type {
  InferenceOfferV2,
  PublicCatalogV2,
} from '@gyblos/protocol/control-types';
import type { Signer } from '@gyblos/protocol/signing';

import { createSellerControlService } from './control';
import {
  checkedControlOffer,
  quoteModel,
  type ControlOffer,
  type ControlOffers,
} from './control-offers';
import { createSellerRecords } from './public-records';
import type { SellerSequence } from './public-sequence';
import { listedPrices } from './seller-offer';

interface SellerControlStartupOptions {
  owner: KeyPairSigner;
  nodeId: string;
  nodeSigner: Signer;
  mint: string;
  payTo: string;
  feePayer: string;
  authorizer: string;
  endpoint: InferenceOfferV2['endpoint'];
  relayOnly: boolean;
  sequence: SellerSequence;
  catalogMs?: number;
  now?: () => number;
  // The daemon's offer set, or one always-listed offer in lab acceptance.
  offers: ControlOffers;
  // Added on top of paid prices in the catalog; the v1 lab listing, which has no fee, passes 0.
  protocolFeeBps?: number;
}

function publicModel(
  options: SellerControlStartupOptions,
  listed: ControlOffer,
): PublicCatalogV2['models'][number] {
  const { selection, offer, model } = checkedControlOffer(listed);
  return {
    ...selection,
    contextTokens: model.contextTokens,
    pricing: {
      network: DEVNET,
      asset: options.mint,
      unit: V2_PRICING.unit,
      ...listedPrices(offer, options.protocolFeeBps),
    },
    reasoning: [...offer.reasoning],
  };
}

// Evaluated at every signing; signing refreshes sequence and lifetime, and refuses an empty listing.
function catalogTemplate(
  options: SellerControlStartupOptions,
): () => PublicCatalogV2 | undefined {
  return () => {
    const listed = options.offers.listed();
    if (!listed.length) return undefined;
    const now = (options.now ?? Date.now)();
    return {
      schemaVersion: CONTROL_RECORD_VERSION,
      kind: PUBLIC_RECORD_KINDS.CATALOG,
      owner: options.owner.address,
      nodeId: options.nodeId,
      sequence: now,
      issuedAt: now,
      expiresAt: options.offers.readiness().validUntil,
      models: listed.map((offer) => publicModel(options, offer)),
      dataPolicy: { retention: DATA_RETENTION.NONE },
    };
  };
}

export async function prepareSellerControl(
  options: SellerControlStartupOptions,
) {
  const { offers } = options;
  const now = options.now ?? Date.now;
  const records = await createSellerRecords({
    template: catalogTemplate(options),
    sequence: options.sequence,
    signer: options.nodeSigner,
    now,
    validUntil: () => offers.readiness().validUntil,
    readiness: () => offers.readiness(),
    catalogMs: options.catalogMs ?? PUBLIC_RECORD_LIMITS.catalogLifetimeMs,
  });
  const service = createSellerControlService({
    records,
    offers,
    context: {
      catalog: records.current(),
      owner: options.owner.address,
      nodeId: options.nodeId,
      payTo: options.payTo,
      feePayer: options.feePayer,
      authorizer: options.authorizer,
      endpoint: options.endpoint,
      relayOnly: options.relayOnly,
      // Superseded per query by the listed offers and each quote's own offer readiness.
      models: offers.listed().map(quoteModel),
      now,
      readiness: () => offers.readiness(),
    },
    nodeSigner: options.nodeSigner,
    ownerSigner: async (bytes) =>
      (await options.owner.signMessages([createSignableMessage(bytes)]))[0]![
        options.owner.address
      ]!,
  });
  return { service, records };
}
