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

void test('a deposit that may still land stays depositing', async () => {
  let undecided = true;
  const { seller, terms, store } = await rig(
    { failDeposit: true, undecided: () => undecided },
    memoryUptoStore(),
  );
  const authorization = authorizationFor(terms);
  await assert.rejects(seller.admit(authorization, terms));
  assert.deepEqual(await seller.recover(), []);
  assert.equal(
    (await store.get(authorization.channelId))?.state,
    UPTO_CHANNEL_STATES.DEPOSITING,
  );
  undecided = false;
  assert.equal((await seller.recover())[0]?.state, UPTO_CHANNEL_STATES.FAILED);
});

void test('recovery acts on the current record, not the listing it started from', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = memoryUptoStore();
  const { seller, terms } = await rig(
    { landThenFailDeposit: true, pauseOpen: () => gate },
    store,
  );
  const first = authorizationFor(terms);
  const second = authorizationFor(terms, {
    channelId: 'Second1111111111111111111111111111111111111',
  });
  await assert.rejects(seller.admit(first, terms));
  await assert.rejects(seller.admit(second, terms));
  const recovering = seller.recover();
  // While recovery waits on the chain for the first channel, the second one settles elsewhere.
  await new Promise((resolve) => setImmediate(resolve));
  const settled = {
    channelId: second.channelId,
    payer: second.payer,
    maxAtomic: second.maxAtomic,
    payload: second.payload,
    terms,
    state: UPTO_CHANNEL_STATES.SETTLED,
    chargedAtomic: '5',
    settlement: {
      channelId: second.channelId,
      chargedAtomic: '5',
      refundedAtomic: '1029995',
      transaction: 't'.repeat(64),
    },
  };
  await store.put(settled);
  release();
  await recovering;
  assert.deepEqual(await store.get(second.channelId), settled);
});

void test('one record that cannot recover does not stop the others', async () => {
  const { seller, terms, store } = await rig({}, memoryUptoStore());
  const refused = authorizationFor(terms);
  await seller.admit(refused, terms);
  // A settlement in progress whose claim the chain refuses (another charge already claimed).
  await seller.settle(refused.channelId, '1');
  const record = await store.get(refused.channelId);
  assert.ok(record);
  await store.put({
    ...record,
    state: UPTO_CHANNEL_STATES.SETTLING,
    chargedAtomic: '2',
    settlement: undefined,
  });
  const pending = authorizationFor(terms, {
    channelId: 'Pending111111111111111111111111111111111111',
  });
  await store.put({
    channelId: pending.channelId,
    payer: pending.payer,
    maxAtomic: pending.maxAtomic,
    payload: pending.payload,
    terms,
    state: UPTO_CHANNEL_STATES.DEPOSITING,
  });
  const changed = await seller.recover();
  assert.deepEqual(
    changed.map((entry) => [entry.channelId, entry.state]),
    [[pending.channelId, UPTO_CHANNEL_STATES.FAILED]],
  );
});
