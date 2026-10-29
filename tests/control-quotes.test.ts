// Tests free quote policy with synthetic signers and clocks; no engine, transport or payment is invoked.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptControlQuote,
  createControlQuote,
} from '@gyblos/core/control-quotes';
import { validateInferenceOffer } from '@gyblos/core/offers';
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  MODEL_IDENTITIES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import {
  controlRequestDigest,
  parseControlQuery,
} from '@gyblos/protocol/control-requests';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import {
  parseOfferV2,
  signOfferV2,
  verifyOfferV2,
} from '@gyblos/protocol/offer-v2';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture';

void test('control quotes bind the complete request and round-trip without reserving capacity', async () => {
  const fixture = await controlFixture();
  const state = fixture.context.readiness();
  const first = await createControlQuote(
    fixture.request,
    fixture.context,
    fixture.ownerSigner,
  );
  const second = await createControlQuote(
    fixture.request,
    fixture.context,
    fixture.ownerSigner,
  );
  assert.deepEqual(first, second);
  assert.deepEqual(fixture.context.readiness(), state);
  assert.deepEqual(
    await acceptControlQuote(first, fixture.request, fixture.trust()),
    first.offer,
  );
  assert.equal(first.offer.expiresAt, state.validUntil);
  assert.equal(first.offer.model.name, 'internal/model');
  const { digest: _digest, ...nameOnly } = first.offer.model;
  assert.equal(
    parseOfferV2({
      ...first.offer,
      model: nameOnly,
      capabilities: {
        ...first.offer.capabilities,
        modelIdentity: MODEL_IDENTITIES.NAME_ONLY,
      },
    }).model.digest,
    undefined,
  );
  assert.throws(() => parseOfferV2({ ...first.offer, model: nameOnly }), {
    code: CONTROL_CODES.INVALID,
  });

  assert.notEqual(first.offer.model.name, first.offer.selection.modelId);
  assert.throws(() =>
    validateInferenceOffer(
      first,
      {
        owner: first.offer.owner,
        nodeId: first.offer.nodeId,
        mint: first.offer.mint,
        payTo: first.offer.payTo,
        buyer: first.offer.buyer,
        maxAtomic: first.offer.maxAtomic,
      },
      first.offer.issuedAt,
      () => {},
    ),
  );
});

void test('control supports free and mixed-zero model pricing without authorizing payment', async () => {
  const fixture = await controlFixture(true);
  const signed = await createControlQuote(
    fixture.request,
    fixture.context,
    fixture.ownerSigner,
  );
  assert.equal(signed.offer.maxAtomic, '0');
  await acceptControlQuote(signed, fixture.request, fixture.trust());
  const paid = await controlFixture();
  await assert.rejects(
    createControlQuote(
      { ...paid.request, params: { ...paid.request.params, maxAtomic: '0' } },
      paid.context,
      paid.ownerSigner,
    ),
    { code: CONTROL_CODES.POLICY },
  );
  paid.catalog.models[0]!.pricing.inputAtomicPerMtok = '0';
  paid.context.catalog = await signPublicV2(paid.catalog, paid.nodeSigner);
  paid.request.params.catalogDigest = await catalogDigestV2(paid.catalog);
  assert.equal(
    (await createControlQuote(paid.request, paid.context, paid.ownerSigner))
      .offer.prices.inputAtomicPerMtok,
    '0',
  );
});

void test('a quote that can charge never names a hot key as payout; a free quote may', async () => {
  const free = await controlFixture(true);
  free.context.payTo = free.context.owner;
  const signed = await createControlQuote(
    free.request,
    free.context,
    free.ownerSigner,
  );
  assert.equal(signed.offer.payTo, signed.offer.owner);
  for (const hot of ['owner', 'feePayer', 'authorizer'] as const) {
    const paid = await controlFixture();
    paid.context.payTo = paid.context[hot];
    await assert.rejects(
      createControlQuote(paid.request, paid.context, paid.ownerSigner),
      { code: CONTROL_CODES.POLICY },
      hot,
    );
  }
});

void test('control rejects unavailable models, levels, stale catalogs and excessive terms before signing', async () => {
  const fixture = await controlFixture();
  let signs = 0;
  const signer = async () => {
    signs++;
    return new Uint8Array(64);
  };
  for (const [params, code] of [
    [
      {
        ...fixture.request.params,
        selection: {
          ...fixture.request.params.selection,
          modelId: 'custom/absent',
        },
      },
      CONTROL_CODES.MODEL,
    ],
    [
      { ...fixture.request.params, reasoning: REASONING_LEVELS.HIGH },
      CONTROL_CODES.LEVEL,
    ],
    [
      { ...fixture.request.params, reasoning: REASONING_LEVELS.LOW },
      CONTROL_CODES.LEVEL,
    ],
    [
      { ...fixture.request.params, catalogDigest: '0'.repeat(64) },
      CONTROL_CODES.STALE,
    ],
    [{ ...fixture.request.params, maxTokens: 9999 }, CONTROL_CODES.POLICY],
    [
      {
        ...fixture.request.params,
        priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
      },
      CONTROL_CODES.POLICY,
    ],
  ] as const)
    await assert.rejects(
      createControlQuote(
        { ...fixture.request, params },
        fixture.context,
        signer,
      ),
      { code },
    );
  fixture.setReadiness({ busy: true });
  await assert.rejects(
    createControlQuote(fixture.request, fixture.context, signer),
    { code: CONTROL_CODES.BUSY },
  );
  assert.equal(signs, 0);
});

void test('control rejects signed substitutions and responses from another request or buyer', async () => {
  const fixture = await controlFixture();
  const signed = await createControlQuote(
    fixture.request,
    fixture.context,
    fixture.ownerSigner,
  );
  const substitutions: Partial<InferenceOfferV2>[] = [
    { buyerNodeId: '3'.repeat(64) },
    { buyer: fixture.context.owner },
    { requestId: '4'.repeat(32) },
    { maxTokens: signed.offer.maxTokens - 1 },
    { reasoning: REASONING_LEVELS.LOW },
    { maxAtomic: '1001' },
    { selection: { ...signed.offer.selection, variant: 'different' } },
    { prices: { inputAtomicPerMtok: '3', outputAtomicPerMtok: '3' } },
    { catalogDigest: '5'.repeat(64) },
    { network: 'solana:other' },
    { mint: fixture.context.owner },
  ];
  for (const change of substitutions) {
    const altered = await signOfferV2(
      { ...signed.offer, ...change },
      fixture.ownerSigner,
    );
    await assert.rejects(
      acceptControlQuote(altered, fixture.request, fixture.trust()),
      { code: CONTROL_CODES.POLICY },
    );
  }
  await assert.rejects(
    createControlQuote(
      fixture.request,
      { ...fixture.context, remoteNodeId: 'a'.repeat(64) },
      fixture.ownerSigner,
    ),
    { code: CONTROL_CODES.POLICY },
  );
  await assert.rejects(
    acceptControlQuote(signed, fixture.request, {
      ...fixture.trust(),
      relayAllowed: () => false,
    }),
    { code: CONTROL_CODES.POLICY },
  );
});

void test('control request digests cover every field and reject unknown or noncanonical input', async () => {
  const fixture = await controlFixture();
  const original = await controlRequestDigest(fixture.request);
  for (const params of [
    { ...fixture.request.params, maxAtomic: '999' },
    { ...fixture.request.params, maxTokens: 101 },
    { ...fixture.request.params, buyerNodeId: '3'.repeat(64) },
    { ...fixture.request.params, buyer: fixture.context.owner },
    { ...fixture.request.params, reasoning: REASONING_LEVELS.LOW },
    { ...fixture.request.params, network: 'solana:other' },
    { ...fixture.request.params, asset: fixture.context.owner },
    { ...fixture.request.params, catalogDigest: '3'.repeat(64) },
    {
      ...fixture.request.params,
      selection: { ...fixture.request.params.selection, variant: 'other' },
    },
    {
      ...fixture.request.params,
      priceCeilings: { inputAtomicPerMtok: '2', outputAtomicPerMtok: '3' },
    },
  ])
    assert.notEqual(
      await controlRequestDigest({ ...fixture.request, params }),
      original,
    );
  for (const maxAtomic of ['0010', '01', '-1', '1e2', '18446744073709551616'])
    assert.throws(
      () =>
        parseControlQuery({
          ...fixture.request,
          params: { ...fixture.request.params, maxAtomic },
        }),
      { code: CONTROL_CODES.INVALID },
    );
  await assert.rejects(
    controlRequestDigest({ ...fixture.request, PRIVATE_SENTINEL: 'PRIVATE' }),
    { code: CONTROL_CODES.INVALID, message: CONTROL_CODES.INVALID },
  );
});

void test('control never publishes a cancelled, expired or changed readiness snapshot', async () => {
  const fixture = await controlFixture();
  const controller = new AbortController();
  fixture.context.signal = controller.signal;
  await assert.rejects(
    createControlQuote(fixture.request, fixture.context, async (bytes) => {
      controller.abort();
      return fixture.ownerSigner(bytes);
    }),
    { code: CONTROL_CODES.CANCELLED },
  );
  delete fixture.context.signal;
  await assert.rejects(
    createControlQuote(fixture.request, fixture.context, async (bytes) => {
      fixture.setReadiness({ generation: 2 });
      return fixture.ownerSigner(bytes);
    }),
    { code: CONTROL_CODES.STALE },
  );
  const valid = await createControlQuote(
    fixture.request,
    fixture.context,
    fixture.ownerSigner,
  );
  await assert.rejects(
    verifyOfferV2(valid, { ...fixture.trust(), now: valid.offer.expiresAt }),
    { code: CONTROL_CODES.EXPIRED },
  );
  await assert.rejects(
    signOfferV2(
      {
        ...valid.offer,
        expiresAt: valid.offer.issuedAt + CONTROL_LIMITS.quoteLifetimeMs + 1,
      },
      fixture.ownerSigner,
    ),
    { code: CONTROL_CODES.EXPIRED },
  );
});

void test('control serves two independent buyers and custom model tuples without fixed PoC identities', async () => {
  const fixture = await controlFixture();
  const model = fixture.catalog.models[0]!;
  const custom = {
    ...model,
    modelId: 'custom/model',
    variant: 'fine-tuned',
    quantization: null,
    pricing: { ...model.pricing, outputAtomicPerMtok: '3' },
  };
  fixture.catalog.models.push(custom);
  fixture.context.catalog = await signPublicV2(
    fixture.catalog,
    fixture.nodeSigner,
  );
  const selection = {
    modelId: custom.modelId,
    variant: custom.variant,
    quantization: custom.quantization,
  };
  fixture.context.models = [
    ...fixture.context.models,
    {
      ...fixture.context.models[0]!,
      selection,
      model: {
        name: 'custom-engine',
        digest: 'sha256:custom',
        contextTokens: custom.contextTokens,
      },
    },
  ];
  fixture.request.params.catalogDigest = await catalogDigestV2(fixture.catalog);
  const other = {
    ...fixture.request,
    requestId: '6'.repeat(32),
    params: {
      ...fixture.request.params,
      buyer: fixture.context.owner,
      buyerNodeId: '7'.repeat(64),
      selection,
    },
  };
  const [first, second] = await Promise.all([
    createControlQuote(fixture.request, fixture.context, fixture.ownerSigner),
    createControlQuote(
      other,
      { ...fixture.context, remoteNodeId: other.params.buyerNodeId },
      fixture.ownerSigner,
    ),
  ]);
  assert.equal(first.offer.prices.outputAtomicPerMtok, '2');
  assert.equal(second.offer.prices.outputAtomicPerMtok, '3');
  assert.equal(second.offer.model.name, 'custom-engine');
  await assert.rejects(
    acceptControlQuote(second, fixture.request, fixture.trust()),
    { code: CONTROL_CODES.POLICY },
  );
});
