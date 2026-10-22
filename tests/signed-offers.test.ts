import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import {
  DEVNET,
  DEVNET_USDC,
  INFERENCE_REQUEST_LIMITS,
  MAX_ATOMIC,
  P2P,
} from '@gyblos/config';
import {
  signInferenceOffer,
  verifyInferenceOffer,
  type InferenceOffer,
} from '@gyblos/node/offers';

async function fixture() {
  const [owner, payout, buyer, feePayer, authorizer] = await Promise.all(
    Array.from({ length: 5 }, () => generateKeyPairSigner()),
  );
  assert.ok(owner && payout && buyer && feePayer && authorizer);
  const now = Date.now();
  const offer: InferenceOffer = {
    schemaVersion: P2P.schemaVersion,
    protocol: P2P.protocol,
    owner: owner.address,
    nodeId: 'synthetic-node-id',
    endpoint: { relayUrl: null, directAddresses: [] },
    relayOnly: false,
    network: DEVNET,
    mint: DEVNET_USDC,
    payTo: payout.address,
    feePayer: feePayer.address,
    authorizer: authorizer.address,
    buyer: buyer.address,
    issuedAt: now,
    expiresAt: now + P2P.offerLifetimeMs,
    prices: { inputAtomic: '1', outputAtomic: '2' },
    maxAtomic: MAX_ATOMIC,
    maxTokens: INFERENCE_REQUEST_LIMITS.maxOutputTokens,
    model: {
      name: 'synthetic-model',
      digest: 'synthetic-digest',
      contextTokens: 2048,
    },
    capabilities: {
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: true,
      modelIdentity: 'digest',
    },
    meteringMode: 'recounted',
  };
  const trust = {
    owner: owner.address,
    nodeId: offer.nodeId,
    mint: offer.mint,
    payTo: payout.address,
    buyer: buyer.address,
    maxAtomic: MAX_ATOMIC,
  };
  return {
    offer,
    trust,
    signed: await signInferenceOffer(offer, owner),
    owner,
    now,
  };
}

test('signed owner offer binds NodeId, complete payment terms and engine capabilities', async () => {
  const { offer, trust, signed, now } = await fixture();
  assert.deepEqual(await verifyInferenceOffer(signed, trust, now), offer);
  for (const field of [
    'nodeId',
    'mint',
    'payTo',
    'feePayer',
    'authorizer',
    'buyer',
  ] as const) {
    const changed = structuredClone(signed);
    changed.offer[field] = 'tampered';
    await assert.rejects(verifyInferenceOffer(changed, trust, now));
  }
  for (const change of [
    (offer: InferenceOffer) => {
      offer.prices.outputAtomic = '3';
    },
    (offer: InferenceOffer) => {
      offer.capabilities.logprobs = true;
    },
    (offer: InferenceOffer) => {
      offer.model.name = 'other-model';
    },
    (offer: InferenceOffer) => {
      offer.endpoint.directAddresses = ['127.0.0.1:9'];
    },
  ]) {
    const changed = structuredClone(signed);
    change(changed.offer);
    await assert.rejects(verifyInferenceOffer(changed, trust, now));
  }
});

test('self-signed attacker and expired/budget-invalid offers are rejected before connecting', async () => {
  const { offer, trust, signed, owner, now } = await fixture();
  const attacker = await generateKeyPairSigner();
  const replacement = await signInferenceOffer(
    { ...offer, owner: attacker.address },
    attacker,
  );
  await assert.rejects(verifyInferenceOffer(replacement, trust, now));
  await assert.rejects(verifyInferenceOffer(signed, trust, offer.expiresAt));
  for (const changed of [
    { ...offer, maxAtomic: '10001' },
    { ...offer, payTo: owner.address },
    { ...offer, meteringMode: 'declared' as const },
    {
      ...offer,
      relayOnly: true,
      endpoint: { relayUrl: null, directAddresses: ['127.0.0.1:9'] },
    },
  ])
    await assert.rejects(
      verifyInferenceOffer(
        await signInferenceOffer(changed, owner),
        trust,
        now,
      ),
    );
});
