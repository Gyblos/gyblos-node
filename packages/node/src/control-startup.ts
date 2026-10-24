// Builds the seller's public control snapshot from cached observations, never from live engine calls.
// Catalog model identity maps explicitly to the already warmed engine description.
import { createSignableMessage, type KeyPairSigner } from '@solana/kit';

import { DEVNET } from '@gyblos/config';
import { PRICES } from '@gyblos/core/constants';
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import { MODEL } from '@gyblos/engine-ollama/model';
import {
  CONTROL_METERING_MODES,
  CONTROL_RECORD_VERSION,
  DATA_RETENTION,
  MODEL_IDS,
  PUBLIC_PRICE_UNIT,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import type {
  EngineCapabilities,
  EngineDescription,
} from '@gyblos/protocol/engine';
import type { Signer } from '@gyblos/protocol/signing';

import { createSellerControlService } from './control.js';
import { createSellerRecords } from './public-records.js';
import type { SellerSequence } from './public-sequence.js';

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
}

function startupRecords(options: SellerControlStartupOptions) {
  const now = Date.now();
  const { selection, reasoning } = startupSelection();
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
            unit: PUBLIC_PRICE_UNIT,
            ...PRICES,
          },
          reasoning,
        },
      ],
      dataPolicy: { retention: DATA_RETENTION.NONE },
    },
    sequence: options.sequence,
    signer: options.nodeSigner,
    now: Date.now,
    validUntil: () => options.readiness().validUntil,
    readiness: options.readiness,
    catalogMs: options.catalogMs ?? PUBLIC_RECORD_LIMITS.catalogLifetimeMs,
  });
}

export async function prepareSellerControl(
  options: SellerControlStartupOptions,
) {
  const { selection, reasoning } = startupSelection();
  const records = await startupRecords(options);
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
          meteringMode: CONTROL_METERING_MODES.RECOUNTED,
        },
      ],
      now: Date.now,
      readiness: options.readiness,
    },
    nodeSigner: options.nodeSigner,
    ownerSigner: async (bytes) =>
      (await options.owner.signMessages([createSignableMessage(bytes)]))[0]![
        options.owner.address
      ]!,
  });
  return { service, records };
}

function startupSelection() {
  const selection = {
    modelId: MODEL_IDS.QWEN3_0_6B,
    variant: null,
    quantization: MODEL.quantization,
  };
  // The pinned template implements only this reasoning level.
  return { selection, reasoning: [REASONING_LEVELS.OFF] };
}
