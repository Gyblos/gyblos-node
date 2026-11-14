// Real SDK/LiteSVM failure cases preserve the original batch authority and never restart a seller.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { requestCloseInstruction } from 'x402-upto-metered';

import { WITHDRAW_STEPS } from '@gyblos/payments-upto';
import { recoverBatchBuyer } from '@gyblos/payments-upto/batch-session';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { batchRecoveryRig } from '../support/batch-recovery';

void test('lost close reply keeps the exact signed wire before send and resolves without a second close', async (t) => {
  const rig = await batchRecoveryRig(t);
  const originalSends = rig.financial.vm.sends();
  const published: string[] = [];
  rig.local.beforeSend(async (wire) => {
    const state = await rig.read();
    const saved = Object.values(state.pending).map((value) =>
      JSON.parse(String(value)),
    );
    assert.ok(
      saved.some(
        (value) =>
          value.wire === wire &&
          value.attempt?.transaction ===
            String(
              getSignatureFromTransaction(
                getTransactionDecoder().decode(Buffer.from(wire, 'base64')),
              ),
            ),
      ),
    );
    published.push(wire);
  });
  rig.local.loseSendReply(true);
  const lost = await rig.recover();
  assert.equal(lost?.step, WITHDRAW_STEPS.CLOSE_REQUESTED);
  assert.equal(lost.confirmed, false);
  assert.equal(lost.settlement, null);
  rig.local.loseSendReply(false);
  await rig.recover();
  assert.equal(rig.financial.vm.sends(), originalSends + 1);
  rig.grace();
  const done = await rig.recover();
  assert.equal(
    done?.settlement?.refundedAtomic,
    rig.financial.terms.depositAtomic,
  );
  assert.equal(
    published.length,
    2,
    'one close and one refund, with no duplicate transaction',
  );
});

void test('a missing finalized opening proof or wrong buyer prevents any control signing', async (t) => {
  const rig = await batchRecoveryRig(t);
  let signs = 0;
  const payer = rig.options.payer;
  const guarded = {
    ...payer,
    signTransactions: async (
      ...args: Parameters<typeof payer.signTransactions>
    ) => {
      signs++;
      return payer.signTransactions(...args);
    },
  };
  const before = await readFile(rig.options.paths.state);
  const sends = rig.financial.vm.sends();
  rig.local.hideOriginal(true);
  await assert.rejects(recoverBatchBuyer({ ...rig.options, payer: guarded }), {
    code: SESSION_CODES.UNVERIFIED,
  });
  assert.deepEqual(await readFile(rig.options.paths.state), before);
  rig.local.hideOriginal(false);
  const foreign = await generateKeyPairSigner();
  await assert.rejects(recoverBatchBuyer({ ...rig.options, payer: foreign }), {
    code: SESSION_CODES.BINDING,
  });
  assert.equal(signs, 0);
  assert.equal(rig.financial.vm.sends(), sends);
});

void test('a native refund without readable final transfer proof stays closing until the original proof returns', async (t) => {
  const rig = await batchRecoveryRig(t);
  await rig.recover();
  await rig.recover();
  rig.grace();
  rig.local.beforeSend(async () => {
    rig.local.hideOriginal(true);
  });
  const missing = await rig.recover();
  assert.equal(missing?.settlement, null);
  assert.equal(
    missing.confirmed,
    false,
    'control confirmation is not financial proof',
  );
  assert.equal((await rig.read()).state, SESSION_STATES.CLOSING);
  const sends = rig.financial.vm.sends();
  rig.local.hideOriginal(false);
  const proven = await rig.recover();
  assert.equal(
    proven?.settlement?.refundedAtomic,
    rig.financial.terms.depositAtomic,
  );
  assert.equal(rig.financial.vm.sends(), sends);
  assert.equal((await rig.read()).state, SESSION_STATES.CLOSED);
});

void test('a changed stored control wire is rejected without a replacement signature or transaction', async (t) => {
  const rig = await batchRecoveryRig(t);
  rig.local.loseSendReply(true);
  await rig.recover();
  const state = await rig.read();
  const key = Object.keys(state.pending).find(
    (key) => JSON.parse(state.pending[key]).attempt,
  );
  assert.ok(key);
  const checkpoint = JSON.parse(state.pending[key]);
  const wire = Buffer.from(checkpoint.wire, 'base64');
  wire[wire.length - 1] = wire[wire.length - 1]! ^ 1;
  checkpoint.wire = wire.toString('base64');
  state.pending[key] = JSON.stringify(checkpoint);
  await writeFile(rig.options.paths.state, JSON.stringify(state), {
    mode: 0o600,
  });
  const sends = rig.financial.vm.sends();
  await assert.rejects(rig.recover());
  assert.equal(rig.financial.vm.sends(), sends);
  assert.notEqual((await rig.read()).state, SESSION_STATES.CLOSED);
});

void test('a signed control interrupted before dispatch resumes the original wire without signing a replacement', async (t) => {
  const rig = await batchRecoveryRig(t);
  const payer = rig.options.payer;
  let signs = 0;
  rig.options.payer = {
    ...payer,
    signTransactions: async (
      ...args: Parameters<typeof payer.signTransactions>
    ) => {
      signs++;
      return payer.signTransactions(...args);
    },
  };
  const attempted: string[] = [];
  rig.local.beforeSend(async (wire) => {
    attempted.push(wire);
    throw new Error('Synthetic dispatch interrupted');
  });
  const before = rig.financial.vm.sends();
  assert.equal((await rig.recover())?.confirmed, false);
  assert.equal(rig.financial.vm.sends(), before);
  rig.local.beforeSend(async (wire) => {
    attempted.push(wire);
  });
  await rig.recover();
  assert.equal(
    rig.financial.vm.sends(),
    before + 1,
    'the original signed close now lands',
  );
  assert.equal(
    signs,
    1,
    'no replacement signature while the original is pending',
  );
  assert.equal(
    new Set(attempted).size,
    1,
    'resubmission uses exactly the retained signed bytes',
  );
});

void test('a valid buyer signature for a different channel cannot replace the stored control intent', async (t) => {
  const rig = await batchRecoveryRig(t);
  rig.local.beforeSend(async () => {
    throw new Error('Synthetic interrupted dispatch');
  });
  await rig.recover();
  const state = await rig.read();
  const key = Object.keys(state.pending).find(
    (key) => JSON.parse(state.pending[key]).attempt,
  );
  assert.ok(key);
  const saved = JSON.parse(state.pending[key]);
  const foreign = await generateKeyPairSigner();
  const hints = rig.financial.vm.hints();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) =>
      setTransactionMessageFeePayerSigner(rig.financial.vm.payer, value),
    (value) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(hints.recentBlockhash),
          lastValidBlockHeight: BigInt(hints.lastValidBlockHeight),
        },
        value,
      ),
    (value) =>
      appendTransactionMessageInstruction(
        requestCloseInstruction(rig.financial.vm.payer, foreign.address),
        value,
      ),
  );
  const signed = await partiallySignTransaction(
    [rig.financial.vm.payer.keyPair],
    compileTransaction(message),
  );
  saved.wire = getBase64EncodedWireTransaction(signed);
  saved.attempt.transaction = String(getSignatureFromTransaction(signed));
  state.pending[key] = JSON.stringify(saved);
  await writeFile(rig.options.paths.state, JSON.stringify(state));
  const sends = rig.financial.vm.sends();
  await assert.rejects(rig.recover(), { code: SESSION_CODES.BINDING });
  assert.equal(rig.financial.vm.sends(), sends);
});
