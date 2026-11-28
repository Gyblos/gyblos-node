// A failed OPEN can be recovered without re-signing the deposit or replaying inference.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_METHODS,
  BatchChannelError,
} from '@gyblos/protocol/batch-channel';
import {
  OPENING_STATUS,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import { batchPrepareFixture } from './support/batch-prepare';

for (const status of Object.values(OPENING_STATUS)) {
  void test(`uncertain OPEN checks the original deposit: ${status}`, async (t) => {
    let observations = 0;
    const f = await batchPrepareFixture(async () => {
      observations++;
      return status;
    });
    t.after(f.close);
    const payloads: string[] = [];
    f.intercept(async (...args) => {
      const [request] = args;
      if (request.method === BATCH_METHODS.OPEN) {
        payloads.push(request.params.payload);
        if (payloads.length === 1) {
          if (status === OPENING_STATUS.PRESENT)
            await f.service.exchange(...args);
          throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
        }
      }
      return f.service.exchange(...args);
    });
    const run = f.buyer.execute(await f.offers.quote(1), f.offers.input);
    if (status === OPENING_STATUS.PRESENT) {
      assert.equal((await run).text, 'ok!');
      assert.deepEqual(payloads, [payloads[0], payloads[0]]);
      assert.equal(f.offers.generations(), 1);
      assert.deepEqual(f.rig.calls, ['deposit']);
    } else {
      await assert.rejects(run, {
        code:
          status === OPENING_STATUS.ABSENT
            ? SESSION_CODES.OPENING_ABSENT
            : SESSION_CODES.OPENING_PENDING,
      });
      assert.equal(payloads.length, 1);
      assert.equal(f.offers.generations(), 0);
    }
    assert.ok(observations >= (status === OPENING_STATUS.UNKNOWN ? 2 : 1));
  });
}

void test('permission withdrawn before OPEN does not claim or observe a deposit', async (t) => {
  let observations = 0;
  const denied = new BatchChannelError(SESSION_CODES.UNVERIFIED);
  const fixture = await batchPrepareFixture(
    async () => {
      observations++;
      return OPENING_STATUS.ABSENT;
    },
    async () => {
      throw denied;
    },
  );
  t.after(fixture.close);
  await assert.rejects(
    fixture.buyer.execute(await fixture.offers.quote(1), fixture.offers.input),
    (error: unknown) => error === denied,
  );
  assert.equal(fixture.rig.buyer.snapshot().channelId, '');
  assert.equal(fixture.pendingOpening(), false);
  assert.equal(observations, 0);
  assert.deepEqual(fixture.rig.calls, []);
});

void test('permission withdrawn after the deposit prevents replay and inference', async (t) => {
  let allowed = true;
  let permits = 0;
  const fixture = await batchPrepareFixture(
    async () => {
      allowed = false;
      return OPENING_STATUS.PRESENT;
    },
    async (work) => {
      permits++;
      if (!allowed) throw new BatchChannelError(SESSION_CODES.UNVERIFIED);
      return work();
    },
  );
  t.after(fixture.close);
  let opens = 0;
  fixture.intercept(async (...args) => {
    const result = await fixture.service.exchange(...args);
    if (args[0].method === BATCH_METHODS.OPEN && ++opens === 1)
      throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
    return result;
  });
  await assert.rejects(
    fixture.buyer.execute(await fixture.offers.quote(1), fixture.offers.input),
    { code: SESSION_CODES.OPENING_PENDING },
  );
  assert.equal(permits, 2);
  assert.equal(opens, 1);
  assert.equal(fixture.pendingOpening(), true);
  assert.notEqual(fixture.rig.buyer.snapshot().channelId, '');
  assert.equal(fixture.offers.generations(), 0);
  assert.deepEqual(fixture.rig.calls, ['deposit']);
});

void test('an acknowledged opening waits for the original deposit before sending inference', async (t) => {
  let reads = 0;
  let visible = false;
  const f = await batchPrepareFixture(async () => {
    visible = ++reads > 1;
    return visible ? OPENING_STATUS.PRESENT : OPENING_STATUS.UNKNOWN;
  });
  t.after(f.close);
  let opens = 0;
  let executions = 0;
  f.intercept(async (...args) => {
    if (args[0].method === BATCH_METHODS.OPEN) opens++;
    if (args[0].method === BATCH_METHODS.EXECUTE) {
      executions++;
      if (!visible) throw new BatchChannelError(SESSION_CODES.UNVERIFIED);
    }
    return f.service.exchange(...args);
  });
  const result = await f.buyer.execute(await f.offers.quote(1), f.offers.input);
  assert.equal(result.text, 'ok!');
  assert.equal(opens, 1);
  assert.equal(executions, 1);
  assert.equal(f.offers.generations(), 1);
  assert.deepEqual(f.rig.calls, ['deposit']);
});

void test('a seller acknowledgement alone cannot authorize inference for an absent deposit', async (t) => {
  const f = await batchPrepareFixture(async () => OPENING_STATUS.ABSENT);
  t.after(f.close);
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    { code: SESSION_CODES.OPENING_ABSENT },
  );
  assert.equal(f.offers.generations(), 0);
  assert.deepEqual(f.rig.calls, ['deposit']);
});
