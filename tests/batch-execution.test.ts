// Shared buyer/seller orchestration verifies usage before signing and never retries possible sends.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  executeBatchBuyer,
  runBatchSellerExecution,
} from '@gyblos/node/batch-session';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';

void test('shared session executes several requests and signs only after independent usage verification', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  let generations = 0;
  const trace: string[] = [];
  for (const index of [1, 2, 3]) {
    const request = rig.request(index);
    const result = await executeBatchBuyer(
      {
        buyer: rig.buyer,
        verify: async () => {
          trace.push('identity');
        },
        open: (payload) => rig.seller().open(payload),
        execute: async (request, signal) => {
          const run = await runBatchSellerExecution({
            seller: rig.seller(),
            request,
            peer: rig.terms.buyerNodeId,
            verify: async () => {},
            outputTokens: 10,
            deadline: rig.now() + 1000,
            now: rig.now,
            signal,
            errors: {
              timeout: () => new Error('synthetic timeout'),
              cancelled: () => new Error('synthetic cancellation'),
            },
            open: () => ({
              generate: async () => {
                generations++;
                trace.push('generate');
                return { usage: 40 };
              },
              measure: () => ({
                inputTokens: 1,
                outputTokens: 1,
                completed: true,
              }),
            }),
            nothing: { inputTokens: 1, outputTokens: 0, completed: false },
            charge: (outcome) => (outcome.outputTokens ? '40' : '0'),
          });
          if (!('value' in run.generated)) throw run.generated.error;
          return { value: run.generated.value, bill: run.settlement };
        },
        verifyUsage: async (value) => {
          trace.push('verify');
          return String(value.usage);
        },
        accept: async (bill, voucher) => {
          trace.push('approve');
          await rig.seller().accept(bill, voucher, rig.terms.buyerNodeId);
        },
      },
      request,
      new AbortController().signal,
    );
    assert.equal(result.usage, 40);
  }
  assert.equal(generations, 3);
  assert.deepEqual(trace, [
    'identity',
    'generate',
    'verify',
    'approve',
    'identity',
    'generate',
    'verify',
    'approve',
    'identity',
    'generate',
    'verify',
    'approve',
  ]);
  assert.deepEqual(rig.calls, ['deposit']);
  assert.equal((await rig.seller().close()).chargedAtomic, '120');
});
void test('possible prompt send is never retried and remains reserved', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  let attempts = 0;
  await assert.rejects(
    executeBatchBuyer(
      {
        buyer: rig.buyer,
        verify: async () => {},
        open: (payload) => rig.seller().open(payload),
        execute: async () => {
          attempts++;
          throw new Error('synthetic lost stream');
        },
        verifyUsage: async () => {
          assert.fail('must not sign without usage');
        },
        accept: async () => {
          assert.fail('must not approve');
        },
      },
      rig.request(1),
      new AbortController().signal,
    ),
    /synthetic lost stream/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(rig.buyer.begin(rig.request(2)), {
    code: SESSION_CODES.BUSY,
  });
});
void test('verification refusal happens before opening a channel or sending a prompt', async (t) => {
  const rig = await sessionRig();
  t.after(rig.dispose);
  let attempts = 0;
  await assert.rejects(
    executeBatchBuyer(
      {
        buyer: rig.buyer,
        verify: async () => {
          throw new Error('synthetic identity refusal');
        },
        open: async () => {
          assert.fail('must not deposit');
        },
        execute: async () => {
          attempts++;
          throw new Error('must not generate');
        },
        verifyUsage: async () => '',
        accept: async () => {},
      },
      rig.request(1),
      new AbortController().signal,
    ),
    /synthetic identity refusal/,
  );
  assert.equal(attempts, 0);
  assert.deepEqual(rig.calls, []);
});
