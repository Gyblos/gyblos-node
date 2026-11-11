// Pure accounting over synthetic parsed requests; no signature claims, clocks, files or payments in policy.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FREE_EXECUTION_ADMISSION } from '@gyblos/core/constants';
import { FreeExecutionAdmission } from '@gyblos/core/free-admission';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import { parseFreeExecutionRequest } from '@gyblos/protocol/free-execution';

async function fixture() {
  const vector: { request: unknown } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/free-execution-v4.json'),
      ),
      'utf8',
    ),
  );
  const source = parseFreeExecutionRequest(vector.request);
  const now = FREE_EXECUTION_ADMISSION.utcDayMs - 10;
  const request = (
    id = 1,
    issuedAt = now,
    peer = source.quote.offer.buyerNodeId,
  ) => ({
    ...source,
    requestId: id.toString(16).padStart(32, '0'),
    input: { ...source.input, maxTokens: 10 },
    quote: {
      ...source.quote,
      offer: {
        ...source.quote.offer,
        buyerNodeId: peer,
        requestId: id.toString(16).padStart(32, '0'),
        issuedAt,
        expiresAt: issuedAt + 1000,
      },
    },
  });
  return { now, request };
}
void test('free caps reserve full output, refund once, and roll over only the new admission day', async () => {
  const { now, request } = await fixture();
  const policy = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 14, perBuyerCap: 14 },
    now - 1,
  );
  const first = policy.enter(request(), 4, now);
  assert.throws(() => policy.enter(request(2), 4, now), {
    code: FREE_EXECUTION_CODES.BUSY,
  });
  first.complete(6);
  first.complete(0);
  assert.throws(() => policy.enter(request(3), 4, now), {
    code: FREE_EXECUTION_CODES.DAILY_CAP,
  });
  policy.enter(request(4, now + 11), 4, now + 11).complete(6);
  assert.throws(() => policy.enter(request(5), 4, now), {
    code: FREE_EXECUTION_CODES.EXPIRED,
  });
});
void test('free caps retain conservative debit when engine usage is uncertain or invalid', async () => {
  const { now, request } = await fixture();
  for (const actual of [undefined, -1, 15, Number.NaN]) {
    const policy = FreeExecutionAdmission.standalone(
      { dailyTokenCap: 14, perBuyerCap: 14 },
      now - 1,
    );
    policy.enter(request(), 4, now).complete(actual);
    assert.throws(() => policy.enter(request(2), 4, now), {
      code: FREE_EXECUTION_CODES.DAILY_CAP,
    });
  }
});
void test('free replay survives daily rollover and resets only after quote expiry', async () => {
  const { now, request } = await fixture();
  const policy = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 100, perBuyerCap: 100 },
    now - 1,
  );
  policy.enter(request(), 4, now).complete(6);
  assert.throws(() => policy.enter(request(), 4, now + 11), {
    code: FREE_EXECUTION_CODES.REPLAY,
  });
  policy.enter(request(1, now + 1001), 4, now + 1001).complete(6);
});
void test('free startup barrier rejects prior and same-tick quotes but admits a later quote', async () => {
  const { now, request } = await fixture();
  const policy = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 100, perBuyerCap: 100 },
    now,
  );
  for (const issuedAt of [now - 1, now])
    assert.throws(() => policy.enter(request(1, issuedAt), 4, now + 1), {
      code: FREE_EXECUTION_CODES.EXPIRED,
    });
  policy.enter(request(1, now + 1), 4, now + 1).complete();
});
void test('free replay and buyer tables reject pressure without evicting live state', async () => {
  const { now, request } = await fixture();
  const replay = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 100000, perBuyerCap: 100000 },
    now - 1,
  );
  for (
    let index = 1;
    index <= FREE_EXECUTION_ADMISSION.maxReplayEntries;
    index++
  )
    replay.enter(request(index), 0, now).complete(0);
  assert.throws(
    () =>
      replay.enter(
        request(FREE_EXECUTION_ADMISSION.maxReplayEntries + 1),
        0,
        now,
      ),
    { code: FREE_EXECUTION_CODES.BUSY },
  );
  assert.throws(() => replay.enter(request(1), 0, now), {
    code: FREE_EXECUTION_CODES.REPLAY,
  });
  const buyers = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 100000, perBuyerCap: 100000 },
    now - 1,
  );
  for (let index = 1; index <= FREE_EXECUTION_ADMISSION.maxBuyers; index++)
    buyers
      .enter(request(index, now, index.toString(16).padStart(64, '0')), 0, now)
      .complete(0);
  assert.throws(
    () => buyers.enter(request(2000, now, 'f'.repeat(64)), 0, now),
    { code: FREE_EXECUTION_CODES.BUSY },
  );
  // A seller's [limits] max_free_buyers_per_day replaces the default.
  const few = FreeExecutionAdmission.standalone(
    { dailyTokenCap: 100000, perBuyerCap: 100000 },
    now - 1,
    2,
  );
  for (const index of [1, 2])
    few
      .enter(request(index, now, index.toString(16).padStart(64, '0')), 0, now)
      .complete(0);
  assert.throws(() => few.enter(request(3, now, 'e'.repeat(64)), 0, now), {
    code: FREE_EXECUTION_CODES.BUSY,
  });
  assert.throws(
    () =>
      FreeExecutionAdmission.standalone(
        { dailyTokenCap: 1, perBuyerCap: 1 },
        now - 1,
        0,
      ),
    { code: FREE_EXECUTION_CODES.LIMIT },
  );
});
