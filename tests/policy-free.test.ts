// Owns the free execution policy: the permit is the request's own ceiling, every cap still applies,
// finishing refunds unused reserved tokens only for a completed sale on a refunding meter, and release
// alone frees the slot without a refund.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FREE_EXECUTION_ADMISSION } from '@gyblos/core/constants';
import { FreeExecutionAdmission } from '@gyblos/core/free-admission';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import { parseFreeExecutionRequest } from '@gyblos/protocol/free-execution';

import { createFreePolicy } from '../packages/node/src/policy-free';

async function freeFixture() {
  const vector: { request: unknown } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/free-execution-v3.json'),
      ),
      'utf8',
    ),
  );
  const source = parseFreeExecutionRequest(vector.request);
  const now = FREE_EXECUTION_ADMISSION.utcDayMs - 10;
  const request = (id: number) => ({
    ...source,
    requestId: id.toString(16).padStart(32, '0'),
    input: { ...source.input, maxTokens: 10 },
    quote: {
      ...source.quote,
      offer: {
        ...source.quote.offer,
        requestId: id.toString(16).padStart(32, '0'),
        issuedAt: now,
        expiresAt: now + 1000,
      },
    },
  });
  return { now, request };
}

void test('free policy: the permit is the request ceiling, and only a completed refunding sale returns tokens', async () => {
  const { now, request } = await freeFixture();
  const admission = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 28, perBuyerCap: 28 },
    now - 1,
  );
  const policy = createFreePolicy(admission, { refunds: true });
  const context = { inputTokens: 4, now };
  const first = await policy.admit(request(1), context);
  assert.equal(first.outputTokens, 10);
  assert.equal(first.deadline, undefined);
  await assert.rejects(policy.admit(request(2), context), {
    code: FREE_EXECUTION_CODES.BUSY,
  });
  // Completed with 4 + 2 of the 14 reserved: 8 tokens return, so a second 14 still fits in 28.
  await policy.finish(first, {
    inputTokens: 4,
    outputTokens: 2,
    completed: true,
  });
  policy.release(first);
  policy.release(first);
  const second = await policy.admit(request(3), context);
  // A failed sale keeps its whole reservation: 6 + 14 + 14 > 28.
  await policy.finish(second, {
    inputTokens: 4,
    outputTokens: 2,
    completed: false,
  });
  policy.release(second);
  await assert.rejects(policy.admit(request(4), context), {
    code: FREE_EXECUTION_CODES.DAILY_CAP,
  });
});

void test('free policy: a declared meter never refunds, and release alone frees the slot without refund', async () => {
  const { now, request } = await freeFixture();
  const admission = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 28, perBuyerCap: 28 },
    now - 1,
  );
  const policy = createFreePolicy(admission, { refunds: false });
  const context = { inputTokens: 4, now };
  const first = await policy.admit(request(1), context);
  await policy.finish(first, {
    inputTokens: 4,
    outputTokens: 2,
    completed: true,
  });
  const second = await policy.admit(request(2), context);
  policy.release(second);
  // 14 + 14 kept: nothing fits.
  await assert.rejects(policy.admit(request(3), context), {
    code: FREE_EXECUTION_CODES.DAILY_CAP,
  });
});
