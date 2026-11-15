// Normal seller startup carries the resolved config.toml capacity into its payment construction port.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'product startup passes config.toml max_sessions to its financial services',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost(
      OFFER_PRICING_KINDS.PAID,
      undefined,
      undefined,
      { maxSessions: 2 },
    );
    t.after(host.close);
    assert.equal(host.servedMaxSessions(), 2);
    assert.equal(host.engine.attempts(), 0);
    assert.deepEqual(host.finance.calls, []);
  },
);
