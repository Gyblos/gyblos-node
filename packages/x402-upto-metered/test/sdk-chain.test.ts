// The SDK-backed chain: deposit and claim through the facilitator's settle, outcomes classified,
// claims idempotent per channel and charge, and vouchers the real facilitator accepts.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { UptoSvmScheme as UptoFacilitatorScheme } from '@x402/svm/upto/facilitator';

import {
  createUptoAuthorization,
  createUptoSdkChain,
  durablePendingStore,
  memoryUptoChainStore,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_CHANNEL_STATES,
  UPTO_DEPOSIT_STATES,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoChannelRecord,
} from '../src/index';
import { rig } from './chain-rig';
import { NOW, parties } from './support';

const rejected = (error: unknown) =>
  error instanceof UptoError &&
  error.code === UPTO_ERROR_CODES.FACILITATOR_REJECTED;

void test('a deposit settles the open for the whole ceiling and records when it was sent', async () => {
  const { chain, calls, authorization, terms } = await rig(async () => ({
    success: true,
    transaction: 'D'.repeat(64),
  }));
  assert.deepEqual(await chain.deposit(authorization, terms), {
    transaction: 'D'.repeat(64),
  });
  assert.deepEqual(calls, [{ type: 'deposit', amount: terms.maxAtomic }]);
});

void test('deposit outcomes: refusals fail at once, pending and thrown failures stay ambiguous', async () => {
  for (const [reason, transaction, exists, definitive] of [
    ['invalid_upto_svm_settlement_simulation', '', false, true],
    ['transaction_failed', '', false, true],
    ['settlement_pending', '', false, false],
    // The open was confirmed but reading it back failed: it is on chain.
    ['invalid_upto_svm_channel_state', 'O'.repeat(64), false, false],
    ['invalid_upto_svm_channel_broadcast', '', false, false],
    // A failure that still returns a signature may have landed, whatever its reason.
    ['transaction_failed', 'T'.repeat(64), false, false],
    // Any refusal is ambiguous once the channel account exists.
    ['invalid_upto_svm_settlement_simulation', '', true, false],
  ] as const) {
    const { chain, authorization, terms } = await rig(
      async () => ({ success: false, transaction, errorReason: reason }),
      { exists },
    );
    await assert.rejects(chain.deposit(authorization, terms), (error) =>
      definitive ? rejected(error) : !rejected(error),
    );
  }
  const thrown = await rig(async () => {
    throw new Error('rpc down');
  });
  await assert.rejects(
    thrown.chain.deposit(thrown.authorization, thrown.terms),
    (error) => !rejected(error),
  );
});

void test('a deposit not seen on chain is pending within the open window and never after it', async () => {
  const unseen = await rig(async () => {
    throw new Error('timeout');
  });
  await assert.rejects(
    unseen.chain.deposit(unseen.authorization, unseen.terms),
  );
  assert.equal(
    await unseen.chain.depositState(unseen.authorization.channelId),
    UPTO_DEPOSIT_STATES.PENDING,
  );
  unseen.advance(90_000);
  assert.equal(
    await unseen.chain.depositState(unseen.authorization.channelId),
    UPTO_DEPOSIT_STATES.NEVER,
  );
  assert.equal(
    await unseen.chain.depositState(
      'NeverSent111111111111111111111111111111111',
    ),
    UPTO_DEPOSIT_STATES.NEVER,
  );
  const seen = await rig(async () => ({ success: true, transaction: 'x' }), {
    exists: true,
  });
  assert.equal(
    await seen.chain.depositState(seen.authorization.channelId),
    UPTO_DEPOSIT_STATES.LANDED,
  );
});

void test('a claim is idempotent per channel and charge', async () => {
  let fail = true;
  const { chain, calls, record, store } = await rig(async () => {
    if (fail) throw new Error('confirmation timed out');
    return { success: true, transaction: 'C'.repeat(64) };
  });
  await assert.rejects(chain.claim(record, '5'));
  // The charge is recorded before the claim is sent, so only it can be retried.
  assert.equal((await store.getClaim(record.channelId))?.chargedAtomic, '5');
  await assert.rejects(
    chain.claim(record, '6'),
    (error) =>
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.ALREADY_SETTLED,
  );
  fail = false;
  const first = await chain.claim(record, '5');
  assert.deepEqual(await chain.claim(record, '5'), first);
  assert.deepEqual(calls, [
    { type: 'claim', amount: '5' },
    { type: 'claim', amount: '5' },
  ]);
});

void test('the voucher is signed by the authorizer and accepted by the real facilitator', async () => {
  const party = await parties();
  // Rejects asynchronously, as an unreachable RPC would.
  const off = async () => {
    throw new Error('offline');
  };
  const facilitator = new UptoFacilitatorScheme({
    getAddresses: () => [party.feePayer.address],
    getSigner: () => party.feePayer,
    getAccountInfo: off,
    getLatestBlockhash: off,
    getSlot: off,
    signTransaction: off,
    simulateTransaction: off,
    sendTransaction: off,
    confirmTransaction: off,
  });
  const reasons: (string | undefined)[] = [];
  const authorization = await createUptoAuthorization(
    party.payer,
    party.terms,
    party.hints,
  );
  const chain = createUptoSdkChain({
    facilitator: {
      settle: async (payload, requirements) => {
        const response = await facilitator.settle(payload, requirements);
        reasons.push(response.errorReason);
        return response;
      },
    },
    verify: async () => true,
    authorizer: party.authorizer,
    store: memoryUptoChainStore(),
    channelExists: async () => false,
    settledClaim: async () => undefined,
    now: () => NOW,
    openWindowMs: 90_000,
    recipients: { ensure: async () => undefined },
  });
  await assert.rejects(
    chain.claim(
      {
        channelId: authorization.channelId,
        payer: authorization.payer,
        maxAtomic: authorization.maxAtomic,
        state: UPTO_CHANNEL_STATES.SETTLING,
        payload: authorization.payload,
        terms: party.terms,
      },
      '250000',
    ),
  );
  // Past the voucher check, the facilitator stops only where it needs the chain's channel state.
  assert.deepEqual(reasons, ['invalid_upto_svm_channel_state']);
});

void test('the pending store keeps broadcast signatures across restarts and forgets on delete', async () => {
  const store = memoryUptoChainStore();
  await durablePendingStore(store).set('upto:claim:x', 'sig');
  // A new adapter over the same store (a restart) still sees it.
  const restarted = durablePendingStore(store);
  assert.equal(await restarted.get('upto:claim:x'), 'sig');
  await restarted.delete('upto:claim:x');
  assert.equal(await restarted.get('upto:claim:x'), undefined);
});

void test('every claim attempt first makes the recipients exist; a failure there sends nothing and keeps the charge', async () => {
  let missing = true;
  const also: (readonly string[] | undefined)[] = [];
  const { chain, steps, record, store } = await rig(
    async () => ({ success: true, transaction: 'C'.repeat(64) }),
    {
      recipients: async (owners) => {
        also.push(owners);
        if (missing) throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
      },
    },
  );
  await assert.rejects(
    chain.claim(record, '5'),
    (error) =>
      error instanceof UptoError && error.code === UPTO_ERROR_CODES.UNAVAILABLE,
  );
  // Nothing reached the program, and only this charge can be retried.
  assert.deepEqual(steps, ['recipients']);
  assert.equal((await store.getClaim(record.channelId))?.chargedAtomic, '5');
  missing = false;
  assert.deepEqual(await chain.claim(record, '5'), {
    transaction: 'C'.repeat(64),
  });
  assert.deepEqual(steps, ['recipients', 'recipients', 'claim']);
  // With the channel payer's own, which distribute refunds.
  assert.deepEqual(also, [[record.payer], [record.payer]]);
  // A claim already known to have landed sends nothing, so it needs no accounts.
  missing = true;
  await chain.claim(record, '5');
  assert.deepEqual(steps, ['recipients', 'recipients', 'claim']);
});

void test('a claim of the whole ceiling refunds nothing, so the payer’s account is not made to exist', async () => {
  const also: (readonly string[] | undefined)[] = [];
  const { chain, record } = await rig(
    async () => ({ success: true, transaction: 'C'.repeat(64) }),
    { recipients: async (owners) => void also.push(owners) },
  );
  await chain.claim(record, record.maxAtomic);
  assert.deepEqual(also, [[]]);
});

void test('a claim that landed before it was recorded is found on chain, not claimed again', async () => {
  let sealed: { transaction: string; chargedAtomic: string } | undefined;
  const { chain, calls, record } = await rig(
    async () => {
      sealed = { transaction: 'S'.repeat(64), chargedAtomic: '5' };
      throw new Error('crashed after broadcast');
    },
    { sealedBy: () => sealed },
  );
  await assert.rejects(chain.claim(record, '5'));
  assert.deepEqual(await chain.claim(record, '5'), {
    transaction: 'S'.repeat(64),
  });
  assert.equal(calls.length, 1);
});

void test('a claim refused because the channel is sealed returns the sealing transaction', async () => {
  const { chain, record } = await rig(
    async () => ({
      success: false,
      transaction: '',
      errorReason: 'invalid_upto_svm_channel_state',
    }),
    {
      sealedBy: () => ({ transaction: 'Z'.repeat(64), chargedAtomic: '5' }),
    },
  );
  assert.deepEqual(await chain.claim(record, '5'), {
    transaction: 'Z'.repeat(64),
  });
});

void test('an expired claim is a definitive refusal; transient failures are not', async () => {
  for (const [reason, definitive] of [
    ['invalid_upto_svm_payload_expired', true],
    ['transaction_failed', false],
    ['invalid_upto_svm_channel_state', false],
  ] as const) {
    const { chain, record } = await rig(async () => ({
      success: false,
      transaction: '',
      errorReason: reason,
    }));
    await assert.rejects(chain.claim(record, '5'), (error) =>
      definitive ? rejected(error) : !rejected(error),
    );
  }
});

void test('a channel sealed for another amount (payer close, cleanup) is never recorded as our claim', async () => {
  for (const reason of [
    'invalid_upto_svm_channel_state',
    'invalid_upto_svm_payload_expired',
  ]) {
    const { chain, record } = await rig(
      async () => ({ success: false, transaction: '', errorReason: reason }),
      { sealedBy: () => ({ transaction: 'Z'.repeat(64), chargedAtomic: '0' }) },
    );
    await assert.rejects(chain.claim(record, '5'), rejected);
  }
  // An expired authorization whose claim did land is still recorded as settled.
  const landed = await rig(
    async () => ({
      success: false,
      transaction: '',
      errorReason: 'invalid_upto_svm_payload_expired',
    }),
    { sealedBy: () => ({ transaction: 'Y'.repeat(64), chargedAtomic: '5' }) },
  );
  assert.deepEqual(await landed.chain.claim(landed.record, '5'), {
    transaction: 'Y'.repeat(64),
  });
});

void test('a different charge already recorded by the chain is a conflict, not a lapse', async () => {
  const { chain, record, store } = await rig(async () => ({
    success: true,
    transaction: 'C'.repeat(64),
  }));
  await store.putClaim({ channelId: record.channelId, chargedAtomic: '4' });
  await assert.rejects(
    chain.claim(record, '5'),
    (error) =>
      error instanceof UptoError &&
      error.code === UPTO_ERROR_CODES.ALREADY_SETTLED,
  );
});

void test('a deposit refusal is ambiguous when the channel lookup itself fails', async () => {
  const { chain, authorization, terms } = await rig(
    async () => ({
      success: false,
      transaction: '',
      errorReason: 'invalid_upto_svm_settlement_simulation',
    }),
    {
      exists: async () => {
        throw new Error('rpc down');
      },
    },
  );
  await assert.rejects(
    chain.deposit(authorization, terms),
    (error) => !rejected(error),
  );
});
