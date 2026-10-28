// Seller control over two synthetic offers (gyblos.toml indexes 0 and 1) with ephemeral unfunded signers:
// the signed catalog, and quotes for either offer through the control service. No engines or network.
import assert from 'node:assert/strict';

import { generateKeyPairSigner } from '@solana/kit';

import { DEVNET } from '@gyblos/config';
import { prepareSellerControl } from '@gyblos/node/control-startup';
import {
  SellerOfferSet,
  type LiveSellerOffer,
} from '@gyblos/node/seller-offer-set';
import {
  CONTROL_METHODS,
  CONTROL_VERSION,
  PUBLIC_RECORD_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type {
  ControlResponse,
  PublicCatalogV2,
} from '@gyblos/protocol/control-types';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';

import {
  PUBLIC_TEST_NOW,
  PUBLIC_TEST_OWNER,
  publicFixture,
} from './public-records';
import { fakeLiveOffer } from './seller-offers';

export const BUYER_NODE = '2'.repeat(64);

export async function offerControlFixture() {
  const now = PUBLIC_TEST_NOW;
  const a = fakeLiveOffer(0, now);
  const b = fakeLiveOffer(1, now);
  const set = new SellerOfferSet(() => now);
  set.add(a.live);
  set.add(b.live);
  const owner = await generateKeyPairSigner();
  const node = publicFixture();
  let sequence = 1;
  const { records, service } = await prepareSellerControl({
    owner,
    nodeId: node.catalog.nodeId,
    nodeSigner: node.signer,
    mint: PUBLIC_TEST_OWNER,
    payTo: owner.address,
    feePayer: owner.address,
    authorizer: owner.address,
    endpoint: { relayUrl: null, directAddresses: [] },
    relayOnly: false,
    sequence: {
      next: async (minimum = 0) => (sequence = Math.max(sequence, minimum) + 1),
    },
    now: () => now,
    offers: set,
  });
  const listedModels = () => {
    const { record } = records.current();
    assert.equal(record.kind, PUBLIC_RECORD_KINDS.CATALOG);
    return (record as PublicCatalogV2).models.map((model) => model.modelId);
  };
  const quote = async (
    live: LiveSellerOffer,
    id = 1,
  ): Promise<ControlResponse> => {
    const { record } = records.current();
    return service.respond(
      {
        version: CONTROL_VERSION,
        requestId: id.toString(16).padStart(32, '0'),
        method: CONTROL_METHODS.OFFER,
        params: {
          buyer: owner.address,
          buyerNodeId: BUYER_NODE,
          selection: live.selection,
          reasoning: REASONING_LEVELS.OFF,
          maxTokens: 10,
          maxAtomic: '0',
          priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
          network: DEVNET,
          asset: PUBLIC_TEST_OWNER,
          catalogDigest: await catalogDigestV2(record as PublicCatalogV2),
        },
      },
      BUYER_NODE,
      new AbortController().signal,
    );
  };
  return {
    a,
    b,
    set,
    records,
    owner: owner.address,
    nodeId: node.catalog.nodeId,
    now,
    listedModels,
    quote,
  };
}
