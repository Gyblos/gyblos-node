// The metered seller's state machine over a fake chain: admission order, write-ahead records,
// single deposit and claim, idempotent settlement and static errors.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUptoSeller,
  memoryUptoStore,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoErrorCode,
  type UptoStore,
} from '../src/index';
import { authorizationFor, fakeChain, NOW, parties, SECRET } from './support';

function rejectsCode(code: UptoErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof UptoError, String(error));
    assert.equal(error.code, code);
    assert.doesNotMatch(String(error.stack), new RegExp(SECRET));
    return true;
  };
}

async function setup(
  chainOptions: Parameters<typeof fakeChain>[0] = {},
  store: UptoStore = memoryUptoStore(),
) {
  const { terms } = await parties();
  const fake = fakeChain(chainOptions);
  let now = NOW;
  const seller = createUptoSeller({
    chain: fake.chain,
    store,
    now: () => now,
    own: terms,
  });
  return {
    ...fake,
    seller,
    store,
    terms,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

void test('admission verifies, writes ahead, deposits once and records the channel', async () => {
  const { seller, terms, events, store } = await setup();
  const authorization = authorizationFor(terms);
  const admission = await seller.admit(authorization, terms);
  assert.deepEqual(admission, {
    channelId: authorization.channelId,
    payer: authorization.payer,
    maxAtomic: terms.maxAtomic,
  });
  assert.deepEqual(events, ['verify', 'deposit']);
  assert.equal((await store.get(authorization.channelId))?.state, 'admitted');
});

void test('admission refuses foreign terms, then reuse, then expiry, without depositing', async () => {
  const rig = await setup({
    accepts: (authorization) => authorization.payload !== 'eA==',
  });
  const authorization = authorizationFor(rig.terms);
  for (const terms of [
    { ...rig.terms, payTo: rig.terms.feePayer },
    { ...rig.terms, network: 'solana:other' },
    { ...rig.terms, asset: rig.terms.payTo },
  ])
    await assert.rejects(
      rig.seller.admit(authorization, terms),
      rejectsCode(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH),
    );
  await assert.rejects(
    rig.seller.admit({ ...authorization, maxAtomic: '1' }, rig.terms),
    rejectsCode(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH),
  );
  await assert.rejects(
    rig.seller.admit({ ...authorization, payload: 'eA==' }, rig.terms),
    rejectsCode(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH),
  );
  assert.ok(!rig.events.includes('deposit'));
  await rig.seller.admit(authorization, rig.terms);
  rig.advance(60_000);
  await assert.rejects(
    rig.seller.admit(authorization, rig.terms),
    rejectsCode(UPTO_ERROR_CODES.CHANNEL_REUSED),
  );
  await assert.rejects(
    rig.seller.admit(
      {
        ...authorization,
        channelId: 'Other11111111111111111111111111111111111111',
      },
      rig.terms,
    ),
    rejectsCode(UPTO_ERROR_CODES.TERMS_EXPIRED),
  );
  assert.equal(rig.events.filter((event) => event === 'deposit').length, 1);
});

void test('concurrent admissions of one channel deposit once', async () => {
  const { seller, terms, events } = await setup({
    pause: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const authorization = authorizationFor(terms);
  const results = await Promise.allSettled([
    seller.admit(authorization, terms),
    seller.admit(authorization, terms),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(events.filter((event) => event === 'deposit').length, 1);
});

void test('an unavailable store prevents any deposit', async () => {
  const store = memoryUptoStore();
  const broken: UptoStore = {
    get: store.get,
    put: async () => {
      throw new Error(`disk full at /home/${SECRET}`);
    },
  };
  const { seller, terms, events } = await setup({}, broken);
  await assert.rejects(
    seller.admit(authorizationFor(terms), terms),
    rejectsCode(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE),
  );
  assert.ok(!events.includes('deposit'));
});

void test('a failed deposit is unavailable, leaks nothing and stays recorded for recovery', async () => {
  const { seller, terms, store } = await setup({ failDeposit: true });
  const authorization = authorizationFor(terms);
  await assert.rejects(
    seller.admit(authorization, terms),
    rejectsCode(UPTO_ERROR_CODES.UNAVAILABLE),
  );
  assert.equal((await store.get(authorization.channelId))?.state, 'depositing');
});

void test('a caller abort is honoured only before the deposit', async () => {
  const { seller, terms, events } = await setup();
  const reason = new Error('caller left');
  await assert.rejects(
    seller.admit(authorizationFor(terms), terms, {
      signal: AbortSignal.abort(reason),
    }),
    (error: unknown) => error === reason,
  );
  assert.ok(!events.includes('deposit'));
  const late = new AbortController();
  const slow = await setup({
    pause: async () => {
      late.abort(new Error('too late'));
    },
  });
  const admission = await slow.seller.admit(
    authorizationFor(slow.terms),
    slow.terms,
    { signal: late.signal },
  );
  assert.equal(admission.maxAtomic, slow.terms.maxAtomic);
});

void test('settlement writes ahead, claims once and repeats the same charge idempotently', async () => {
  const { seller, terms, events, store } = await setup();
  const { channelId } = await seller.admit(authorizationFor(terms), terms);
  const first = await seller.settle(channelId, '250000');
  assert.deepEqual(first, {
    channelId,
    chargedAtomic: '250000',
    refundedAtomic: '780000',
    transaction: first.transaction,
  });
  assert.deepEqual(await seller.settle(channelId, '250000'), first);
  await assert.rejects(
    seller.settle(channelId, '250001'),
    rejectsCode(UPTO_ERROR_CODES.ALREADY_SETTLED),
  );
  assert.equal(events.filter((event) => event === 'claim').length, 1);
  assert.equal((await store.get(channelId))?.state, 'settled');
});

void test('charges above the ceiling, malformed charges and unknown channels are refused', async () => {
  const { seller, terms, events } = await setup();
  const { channelId } = await seller.admit(authorizationFor(terms), terms);
  for (const charge of ['1030001', '-1', '1.5', ''])
    await assert.rejects(
      seller.settle(channelId, charge),
      rejectsCode(UPTO_ERROR_CODES.CHARGE_EXCEEDS_CEILING),
    );
  await assert.rejects(
    seller.settle('Unknown1111111111111111111111111111111111111', '0'),
    rejectsCode(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH),
  );
  assert.ok(!events.includes('claim'));
});

void test('a failed claim keeps its charge: only the same charge can be retried', async () => {
  let failing = true;
  const { seller, terms, store, claims } = await setup({
    failClaim: () => failing,
  });
  const { channelId } = await seller.admit(authorizationFor(terms), terms);
  await assert.rejects(
    seller.settle(channelId, '100'),
    rejectsCode(UPTO_ERROR_CODES.UNAVAILABLE),
  );
  const record = await store.get(channelId);
  assert.equal(record?.state, 'settling');
  assert.equal(record?.chargedAtomic, '100');
  await assert.rejects(
    seller.settle(channelId, '101'),
    rejectsCode(UPTO_ERROR_CODES.ALREADY_SETTLED),
  );
  failing = false;
  assert.equal((await seller.settle(channelId, '100')).chargedAtomic, '100');
  assert.deepEqual(claims, [{ channelId, chargedAtomic: '100' }]);
});

void test('concurrent settlements with different charges claim once', async () => {
  const { seller, terms, claims } = await setup({
    pause: () => new Promise((resolve) => setImmediate(resolve)),
  });
  const { channelId } = await seller.admit(authorizationFor(terms), terms);
  const results = await Promise.allSettled([
    seller.settle(channelId, '1'),
    seller.settle(channelId, '2'),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(claims.length, 1);
});
