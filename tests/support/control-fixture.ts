// Owns synthetic multi-model catalogs and unfunded owner/node signers for pure control tests.
import { createSignableMessage, generateKeyPairSigner } from '@solana/kit';

import type { QuoteContext } from '@gyblos/core/control-quotes';
import {
  CONTROL_METERING_MODES,
  CONTROL_METHODS,
  CONTROL_RECORD_VERSION,
  CONTROL_VERSION,
  MODEL_IDENTITIES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type {
  OfferQuery,
  PublicCatalogV2,
} from '@gyblos/protocol/control-types';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';
import type { Signer } from '@gyblos/protocol/signing';

import { PUBLIC_TEST_NOW, publicFixture } from './public-records.js';

export async function controlFixture(free = false) {
  const source = publicFixture();
  const owner = await generateKeyPairSigner();
  const ownerSigner: Signer = async (bytes) => {
    const signatures = await owner.signMessages([createSignableMessage(bytes)]);
    return signatures[0]![owner.address]!;
  };
  const catalog: PublicCatalogV2 = {
    ...source.catalog,
    schemaVersion: CONTROL_RECORD_VERSION,
    owner: owner.address,
    models: source.catalog.models.map((model) => ({
      ...model,
      pricing: {
        ...model.pricing,
        inputAtomic: free ? '0' : '1',
        outputAtomic: free ? '0' : '2',
      },
      reasoning: [REASONING_LEVELS.OFF, REASONING_LEVELS.LOW],
    })),
  };
  const signed = await signPublicV2(catalog, source.signer);
  const selection = {
    modelId: catalog.models[0]!.modelId,
    variant: catalog.models[0]!.variant,
    quantization: catalog.models[0]!.quantization,
  };
  const request: OfferQuery = {
    version: CONTROL_VERSION,
    requestId: '1'.repeat(32),
    method: CONTROL_METHODS.OFFER,
    params: {
      buyer: source.catalog.owner,
      buyerNodeId: '2'.repeat(64),
      selection,
      reasoning: REASONING_LEVELS.OFF,
      maxTokens: 100,
      maxAtomic: free ? '0' : '1000',
      priceCeilings: { inputAtomic: '3', outputAtomic: '3' },
      network: catalog.models[0]!.pricing.network,
      asset: catalog.models[0]!.pricing.asset,
      catalogDigest: await catalogDigestV2(catalog),
    },
  };
  let now = PUBLIC_TEST_NOW;
  let readiness = {
    generation: 1,
    busy: false,
    observedAt: now,
    validUntil: now + 20000,
  };
  const context: QuoteContext = {
    catalog: signed,
    owner: owner.address,
    nodeId: catalog.nodeId,
    remoteNodeId: request.params.buyerNodeId,
    payTo: source.catalog.owner,
    feePayer: owner.address,
    authorizer: owner.address,
    endpoint: { relayUrl: 'https://relay.example', directAddresses: [] },
    relayOnly: true,
    models: [
      {
        selection,
        model: {
          name: 'internal/model',
          digest: 'sha256:synthetic',
          contextTokens: 2048,
        },
        capabilities: {
          reportsUsage: true,
          logprobs: false,
          cancellable: true,
          recountable: true,
          modelIdentity: MODEL_IDENTITIES.DIGEST,
        },
        reasoning: [REASONING_LEVELS.OFF],
        meteringMode: CONTROL_METERING_MODES.RECOUNTED,
      },
    ],
    now: () => now,
    readiness: () => ({ ...readiness }),
  };
  const trust = () => ({
    owner: owner.address,
    nodeId: catalog.nodeId,
    now,
    catalog: context.catalog,
    relayAllowed: (origin: string) => origin === 'https://relay.example',
  });
  return {
    request,
    catalog,
    context,
    ownerSigner,
    nodeSigner: source.signer,
    trust,
    setNow(value: number) {
      now = value;
    },
    setReadiness(value: Partial<typeof readiness>) {
      readiness = { ...readiness, ...value };
    },
  };
}
