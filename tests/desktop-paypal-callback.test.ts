// Exercises the loopback-only PayPal return page with synthetic tokens.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDesktopPaypalCallback } from '@gyblos/desktop/paypal-callback';

void test('callback is loopback-only and never reflects payment parameters', async () => {
  const callback = await openDesktopPaypalCallback();
  try {
    const origin = new URL(callback.origin);
    assert.equal(origin.hostname, '127.0.0.1');
    assert.equal(origin.protocol, 'http:');
    for (const path of ['/paypal/approved', '/paypal/cancelled']) {
      const response = await fetch(
        `${callback.origin}${path}?token=private-synthetic`,
      );
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /return to gyblos/i);
      assert.doesNotMatch(text, /private-synthetic/);
    }
    const missing = await fetch(`${callback.origin}/other`);
    assert.equal(missing.status, 404);
    const post = await fetch(`${callback.origin}/paypal/approved`, {
      method: 'POST',
    });
    assert.equal(post.status, 404);
  } finally {
    await callback.close();
  }
});
