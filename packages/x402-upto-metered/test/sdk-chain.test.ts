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
  UPTO_CHANNEL_STATES,
  UPTO_DEPOSIT_STATES,
  UPTO_ERROR_CODES,
  UptoError,
  type UptoChannelRecord,
} from '../src/index';
import { NOW, parties } from './support';

type Settle = (
  payload: PaymentPayload,
  requirements: PaymentRequirements,
) => Promise<{ success: boolean; transaction: string; errorReason?: string }>;

async function rig(settle: Settle, options: { exists?: boolean } = {}) {
  const party = await parties();
  const authorization = await createUptoAuthorization(
    party.payer,
    party.terms,
    party.hints,
  );
  const calls: { type: unknown; amount: string }[] = [];
  let now = NOW;
  const store = memoryUptoChainStore();
  const chain = createUptoSdkChain({
    facilitator: {
      settle: async (payload, requirements) => {
        calls.push({ type: payload.payload.type, amount: requirements.amount });
        return {
          network: requirements.network,
          payer: '',
          ...(await settle(payload, requirements)),
        };
      },
    },
    verify: async () => true,
    authorizer: party.authorizer,
    store,
    channelExists: async () => options.exists ?? false,
    now: () => now,
    openWindowMs: 90_000,
  });
  const record: UptoChannelRecord = {
    channelId: authorization.channelId,
    payer: authorization.payer,
    maxAtomic: authorization.maxAtomic,
    state: UPTO_CHANNEL_STATES.ADMITTED,
    payload: authorization.payload,
    terms: party.terms,
  };
  return {
    ...party,
    authorization,
    chain,
    calls,
    store,
    record,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

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
  for (const [reason, definitive] of [
    ['invalid_upto_svm_settlement_simulation', true],
    ['transaction_failed', true],
    ['settlement_pending', false],
  ] as const) {
    const { chain, authorization, terms } = await rig(async () => ({
      success: false,
      transaction: '',
      errorReason: reason,
    }));
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
  await assert.rejects(chain.claim(record, '6'), rejected);
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
    now: () => NOW,
    openWindowMs: 90_000,
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

void test('the durable pending store never forgets a broadcast signature', async () => {
  const store = memoryUptoChainStore();
  const pending = durablePendingStore(store);
  await pending.set('upto:claim:x', 'sig');
  await pending.delete('upto:claim:x');
  assert.equal(await pending.get('upto:claim:x'), 'sig');
});
