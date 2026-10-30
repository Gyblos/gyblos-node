// Crash and failure points between the store and the chain: nothing is lost, nothing is spent twice.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUptoSeller,
  memoryUptoStore,
  UPTO_CHANNEL_STATES,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoChannelRecord,
  type UptoStore,
} from '../src/index';
import { authorizationFor, fakeChain, NOW, parties } from './support';

// A store that fails the first write into `state`, as a crash right after the chain call would.
function failingOnce(state: UptoChannelRecord['state']): UptoStore {
  const store = memoryUptoStore();
  let failed = false;
  return {
    get: store.get,
    list: store.list,
    async put(record) {
      if (record.state === state && !failed) {
        failed = true;
        throw new Error('crashed');
      }
      return store.put(record);
    },
  };
}

async function rig(
  chainOptions: Parameters<typeof fakeChain>[0],
  store: UptoStore,
) {
  const { terms } = await parties();
  const fake = fakeChain(chainOptions);
  const seller = createUptoSeller({
    chain: fake.chain,
    store,
    now: () => NOW,
    own: terms,
  });
  return { ...fake, seller, store, terms };
}

const code = (expected: string) => (error: unknown) =>
  error instanceof UptoError && error.code === expected;

void test('a deposit that landed before the crash is recovered as admitted and can settle', async () => {
  const store = failingOnce(UPTO_CHANNEL_STATES.ADMITTED);
  const { seller, terms } = await rig({}, store);
  const authorization = authorizationFor(terms);
  await assert.rejects(
    seller.admit(authorization, terms),
    code(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE),
  );
  await assert.rejects(
    seller.settle(authorization.channelId, '0'),
    code(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH),
  );
  const [recovered] = await seller.recover();
  assert.equal(recovered?.state, UPTO_CHANNEL_STATES.ADMITTED);
  assert.equal(
    (await seller.settle(authorization.channelId, '0')).chargedAtomic,
    '0',
  );
});

void test('an ambiguous deposit that landed is admitted; one that did not is failed', async () => {
  const landed = await rig({ landThenFailDeposit: true }, memoryUptoStore());
  const authorization = authorizationFor(landed.terms);
  await assert.rejects(
    landed.seller.admit(authorization, landed.terms),
    code(UPTO_ERROR_CODES.UNAVAILABLE),
  );
  assert.equal(
    (await landed.seller.recover())[0]?.state,
    UPTO_CHANNEL_STATES.ADMITTED,
  );
  const lost = await rig({ failDeposit: true }, memoryUptoStore());
  await assert.rejects(
    lost.seller.admit(authorizationFor(lost.terms), lost.terms),
    code(UPTO_ERROR_CODES.UNAVAILABLE),
  );
  assert.equal(
    (await lost.seller.recover())[0]?.state,
    UPTO_CHANNEL_STATES.FAILED,
  );
  await assert.rejects(
    lost.seller.settle(authorizationFor(lost.terms).channelId, '0'),
    code(UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH),
  );
  await assert.rejects(
    lost.seller.admit(authorizationFor(lost.terms), lost.terms),
    code(UPTO_ERROR_CODES.CHANNEL_REUSED),
  );
});

void test('a definitive refusal fails the channel at once', async () => {
  const { seller, terms, store } = await rig(
    { rejectDeposit: true },
    memoryUptoStore(),
  );
  const authorization = authorizationFor(terms);
  await assert.rejects(
    seller.admit(authorization, terms),
    code(UPTO_ERROR_CODES.FACILITATOR_REJECTED),
  );
  assert.equal(
    (await store.get(authorization.channelId))?.state,
    UPTO_CHANNEL_STATES.FAILED,
  );
  assert.deepEqual(await seller.recover(), []);
});

void test('a claim that landed before the crash is not claimed again on retry or recovery', async () => {
  const store = failingOnce(UPTO_CHANNEL_STATES.SETTLED);
  const { seller, terms, claims } = await rig({}, store);
  const { channelId } = await seller.admit(authorizationFor(terms), terms);
  await assert.rejects(
    seller.settle(channelId, '5'),
    code(UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE),
  );
  const retried = await seller.settle(channelId, '5');
  assert.deepEqual(await seller.settle(channelId, '5'), retried);
  assert.deepEqual(claims, [{ channelId, chargedAtomic: '5' }]);
  assert.deepEqual(await seller.recover(), []);
});

void test('recovery completes a settlement left in progress with its recorded charge', async () => {
  let failing = true;
  const { seller, terms, claims } = await rig(
    { failClaim: () => failing },
    memoryUptoStore(),
  );
  const { channelId } = await seller.admit(authorizationFor(terms), terms);
  await assert.rejects(
    seller.settle(channelId, '7'),
    code(UPTO_ERROR_CODES.UNAVAILABLE),
  );
  failing = false;
  const [recovered] = await seller.recover();
  assert.equal(recovered?.state, UPTO_CHANNEL_STATES.SETTLED);
  assert.equal(recovered?.settlement?.chargedAtomic, '7');
  assert.deepEqual(claims, [{ channelId, chargedAtomic: '7' }]);
});
