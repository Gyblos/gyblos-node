// Independent-review regressions exercise actual SDK/Kit response handling and native channel transitions.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSolanaRpcFromTransport } from '@solana/kit';
import { sealInstruction } from 'x402-upto-metered';

import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { batchRecoveryRig } from '../support/batch-recovery';

void test('a missing finalized status context cannot authorize original-wire resubmission', async (t) => {
  const rig = await batchRecoveryRig(t);
  rig.local.beforeSend(async () => {
    throw new Error('Synthetic interrupted dispatch');
  });
  await rig.recover();
  const sends = rig.financial.vm.sends();
  rig.local.beforeSend(async () => {});
  const malformed = createSolanaRpcFromTransport(async <T>() => {
    // Deliberately malformed external bytes pass through the real Kit response transformer.
    const value: unknown = JSON.parse(
      '{"jsonrpc":"2.0","id":"synthetic","result":{"context":{},"value":[null]}}',
    );
    return value as T;
  });
  let reads = 0;
  const original = rig.options.rpc;
  rig.options.rpc = new Proxy(original, {
    get(target, name) {
      if (name === 'getSignatureStatuses')
        return (...args: Parameters<typeof original.getSignatureStatuses>) => {
          reads++;
          return reads === 2
            ? malformed.getSignatureStatuses(...args)
            : original.getSignatureStatuses(...args);
        };
      return Reflect.get(target, name);
    },
  });
  await assert.rejects(rig.recover(), { code: SESSION_CODES.UNVERIFIED });
  assert.equal(reads, 2);
  assert.equal(rig.financial.vm.sends(), sends);
});

void test('an unsigned refund intent expires safely after an independent seal changes the message', async (t) => {
  const rig = await batchRecoveryRig(t);
  await rig.recover();
  await rig.recover();
  rig.grace();
  const payer = rig.options.payer;
  let signs = 0;
  rig.options.payer = {
    ...payer,
    signTransactions: async (...args) => {
      signs++;
      if (signs === 1) throw new Error('Synthetic lost signer reply');
      return payer.signTransactions(...args);
    },
  };
  await assert.rejects(rig.recover());
  const before = await rig.read();
  await rig.financial.vm.send([sealInstruction(before.channelId)]);
  const unchanged = await rig.read();
  await assert.rejects(rig.recover(), { code: SESSION_CODES.BINDING });
  assert.equal(
    signs,
    1,
    'no changed message while the original may still land',
  );
  assert.deepEqual(await rig.read(), unchanged);
  rig.financial.vm.expire();
  const result = await rig.recover();
  assert.equal(
    result?.settlement?.refundedAtomic,
    rig.financial.terms.depositAtomic,
  );
  assert.equal((await rig.read()).state, SESSION_STATES.CLOSED);
  assert.equal(signs, 2);
});
