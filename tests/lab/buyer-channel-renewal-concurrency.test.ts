import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { bounded } from '@gyblos/node/buyer-operation';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  BUYER_KEY_CODES,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';

import { batchDeferred } from '../support/batch-deferred';
import { HTTP_MULTI } from '../support/http-multiseller-constants';
import { httpMultiHttpObservation } from '../support/http-multiseller-http';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { buyerClient } from '../support/session-product-client';
import { sessionProductHost } from '../support/session-product-host';

async function fundedChannel(t: TestContext) {
  const request = globalThis.fetch;
  const opening = batchDeferred<void>();
  const release = batchDeferred<void>();
  const deadline = AbortSignal.timeout(60000);
  let deposited = 0;
  const host = await sessionProductHost(
    undefined,
    undefined,
    undefined,
    undefined,
    {
      depositAtomic: '10000',
      renewalBudgetAtomic: '30000',
      beforeDeposit: async () => {
        if (++deposited === 2) {
          opening.resolve();
          await bounded(release.promise, deadline);
        }
      },
    },
  );
  t.after(host.close);
  const client = await buyerClient(host, request, '50000');
  const first = await client.ask(64, deadline);
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  return { host, request, client, opening, release, deadline };
}

void test(
  'cancelled and timed-out delegated waiters never dispatch after a shared channel renewal',
  { skip: NATIVE_CAPABILITY.transportSkip, timeout: 90000 },
  async (t) => {
    const {
      host,
      request,
      client: { ask, owner, delegated },
      opening,
      release,
      deadline,
    } = await fundedChannel(t);
    const endpoint = host.buyer().url;
    const policy = parseBuyerApiPolicy(
      await (await owner(new URL(BUYER_API.STATUS_PATH, endpoint))).json(),
    );
    const abort = new AbortController();
    const waiters = ['cancelled', 'timed-out'].map((marker) => ({
      marker,
      probe: httpMultiHttpObservation(host, marker),
    }));
    const primary = ask(64, deadline);
    const completed: Promise<unknown>[] = [primary];
    try {
      await Promise.race([
        bounded(opening.promise, deadline),
        primary.then(() => assert.fail('Original request must start renewal')),
      ]);
      const timeout = AbortSignal.timeout(2000);
      for (const { marker } of waiters) {
        const signal = marker === 'cancelled' ? abort.signal : timeout;
        const pending = request(endpoint, {
          method: 'POST',
          signal,
          headers: {
            authorization: 'Bearer ' + delegated,
            'content-type': 'application/json',
            [HTTP_MULTI.traceHeader]: marker,
          },
          body: JSON.stringify({
            model: policy.model,
            messages: [{ role: 'user', content: marker }],
          }),
        });
        completed.push(
          assert.rejects(
            pending,
            (error: unknown) => signal.aborted && error === signal.reason,
          ),
        );
      }
      await bounded(
        Promise.all(waiters.map((waiter) => waiter.probe.arrived)),
        deadline,
      );
      abort.abort();
      await bounded(Promise.all(completed.slice(1)), deadline);
      await bounded(
        Promise.all(waiters.map((waiter) => waiter.probe.closed)),
        deadline,
      );
      assert.equal(host.engine.attempts(), 1);
      assert.equal(host.finance.approvals(), 1);
      release.resolve();
      const response = await primary;
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      assert.equal(host.engine.attempts(), 2);
      assert.equal(host.finance.approvals(), 2);
      assert.equal(
        host.finance.calls.filter((call) => call === 'deposit').length,
        2,
      );
      const { snapshot } = parseBuyerApiKeysReply(
        await (await owner(new URL(BUYER_API_KEYS.PATH, endpoint))).json(),
      );
      assert.equal(snapshot.blocked, false);
      assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
    } finally {
      abort.abort();
      release.resolve();
      await Promise.allSettled(completed);
      for (const { probe } of waiters) probe.dispose();
    }
  },
);

void test(
  'restarting while a replacement deposit is in flight cannot repeat that deposit or dispatch the disconnected question',
  { skip: NATIVE_CAPABILITY.transportSkip, timeout: 90000 },
  async (t) => {
    const {
      host,
      client: { ask },
      opening,
      release,
      deadline,
    } = await fundedChannel(t);
    const lost = ask(64, deadline);
    const outcome = lost.then(
      (response) => response.status,
      () => undefined,
    );
    let restarted: Promise<unknown> | undefined;
    try {
      await Promise.race([
        bounded(opening.promise, deadline),
        outcome.then(() =>
          assert.fail('Expected in-flight replacement before restart'),
        ),
      ]);
      restarted = host.restartBuyer();
      const disconnected = await bounded(outcome, deadline);
      assert.notEqual(disconnected, 200);
      release.resolve();
      await bounded(restarted, deadline);
      assert.equal(
        host.finance.calls.filter((call) => call === 'deposit').length,
        2,
      );
      assert.equal(host.engine.attempts(), 1);
      const next = await ask(64, deadline);
      const data = await next.json();
      assert.equal(next.status, 503);
      assert.equal(data.error.code, BUYER_KEY_CODES.REVIEW);
      assert.equal(data.error[BUYER_API.NEVER_SENT_FIELD], true);
      assert.equal(
        host.finance.calls.filter((call) => call === 'deposit').length,
        2,
      );
      assert.equal(host.engine.attempts(), 1);
      assert.equal(host.finance.approvals(), 1);
    } finally {
      release.resolve();
      await Promise.allSettled(restarted ? [outcome, restarted] : [outcome]);
    }
  },
);
