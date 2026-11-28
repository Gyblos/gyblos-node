import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { buyerClient } from '../support/session-product-client';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'capacity refusal during replacement preparation releases only the unsent key allowance',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const request = globalThis.fetch;
    const host = await sessionProductHost(
      undefined,
      undefined,
      undefined,
      undefined,
      { depositAtomic: '10000', renewalBudgetAtomic: '30000' },
    );
    t.after(host.close);
    const { ask, owner } = await buyerClient(host, request, '50000');
    const first = await ask(64);
    assert.equal(first.status, 200, await first.clone().text());
    const before = await keyState();
    const permit = t.mock.method(
      host.finance.registry,
      'permits',
      async () => false,
    );
    const rejected = await ask(64);
    assert.ok(!rejected.ok);
    await rejected.text();
    assert.ok(permit.mock.callCount() > 0);
    const after = await keyState();
    assert.equal(after.blocked, false);
    assert.equal(after.keys[0]?.reservedAtomic, '0');
    assert.equal(after.keys[0]?.spentAtomic, before.keys[0]?.spentAtomic);
    assert.equal(
      host.finance.calls.filter((call) => call === 'deposit').length,
      1,
    );
    permit.mock.restore();
    const resumed = await ask(64);
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal(
      host.finance.calls.filter((call) => call === 'deposit').length,
      2,
    );
    async function keyState() {
      return parseBuyerApiKeysReply(
        await (
          await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
        ).json(),
      ).snapshot;
    }
  },
);
