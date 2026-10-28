// Builds the seller's public control snapshot from cached observations, never from live engine calls.
// Catalog model identity maps explicitly to the already warmed engine description.
import { createSignableMessage, type KeyPairSigner } from '@solana/kit';

import { DEVNET } from '@gyblos/config';
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import {
  CONTROL_RECORD_VERSION,
  DATA_RETENTION,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
  V2_PRICING,
} from '@gyblos/protocol/constants';
import type {
  InferenceOfferV2,
  ModelSelection,
} from '@gyblos/protocol/control-types';
import type {
  EngineCapabilities,
  EngineDescription,
} from '@gyblos/protocol/engine';
import type { Signer } from '@gyblos/protocol/signing';

import { createSellerControlService } from './control';
import type { OfferMetering } from './engine-factory';
import { createSellerRecords } from './public-records';
import type { SellerSequence } from './public-sequence';
import { listedPrices, type SellerCatalogOffer } from './seller-offer';

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
  model: EngineDescription;
  capabilities: EngineCapabilities;
  validUntil: number;
  readiness: () => QuoteReadiness;
  sequence: SellerSequence;
  catalogMs?: number;
  now?: () => number;
  // The listing: from gyblos.toml in the daemon, chosen by the caller in lab acceptance.
  offer: SellerCatalogOffer;
  // From the engine plugin: what the catalog lists and how delivered tokens are counted.
  selection: ModelSelection;
  meteringMode: OfferMetering['mode'];
}

function startupRecords(
  options: SellerControlStartupOptions,
  offer: SellerCatalogOffer,
) {
  const now = (options.now ?? Date.now)();
  const { selection, reasoning } = startupSelection(options);
  return createSellerRecords({
    template: {
      schemaVersion: CONTROL_RECORD_VERSION,
      kind: PUBLIC_RECORD_KINDS.CATALOG,
      owner: options.owner.address,
      nodeId: options.nodeId,
      sequence: now,
      issuedAt: now,
      expiresAt: options.validUntil,
      models: [
        {
          ...selection,
          contextTokens: options.model.contextTokens,
          pricing: {
            network: DEVNET,
            asset: options.mint,
            unit: V2_PRICING.unit,
            ...listedPrices(offer),
          },
          reasoning,
        },
      ],
      dataPolicy: { retention: DATA_RETENTION.NONE },
    },
    sequence: options.sequence,
    signer: options.nodeSigner,
    now: options.now ?? Date.now,
    validUntil: () => options.readiness().validUntil,
    readiness: options.readiness,
    catalogMs: options.catalogMs ?? PUBLIC_RECORD_LIMITS.catalogLifetimeMs,
  });
}

export async function prepareSellerControl(
  options: SellerControlStartupOptions,
) {
  const { offer } = options;
  const { selection, reasoning } = startupSelection(options);
  const records = await startupRecords(options, offer);
  const service = createSellerControlService({
    records,
    context: {
      catalog: records.current(),
      owner: options.owner.address,
      nodeId: options.nodeId,
      payTo: options.payTo,
      feePayer: options.feePayer,
      authorizer: options.authorizer,
      endpoint: options.endpoint,
      relayOnly: options.relayOnly,
      models: [
        {
          selection,
          model: options.model,
          capabilities: options.capabilities,
          reasoning,
          meteringMode: options.meteringMode,
        },
      ],
      now: options.now ?? Date.now,
      readiness: options.readiness,
    },
    nodeSigner: options.nodeSigner,
    ownerSigner: async (bytes) =>
      (await options.owner.signMessages([createSignableMessage(bytes)]))[0]![
        options.owner.address
      ]!,
  });
  return { service, records, offer };
}

// The engine plugin's selection for the listed model; its plugin admits only levels it implements.
function startupSelection(options: SellerControlStartupOptions) {
  return {
    selection: { ...options.selection },
    reasoning: [...options.offer.reasoning],
  };
}
