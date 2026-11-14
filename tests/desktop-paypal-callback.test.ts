// Exercises the loopback-only PayPal return page with synthetic tokens.
import assert from 'node:assert/strict';
import { request } from 'node:http';
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
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
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

void test('malformed return URLs cannot crash the loopback listener', async () => {
  const callback = await openDesktopPaypalCallback();
  try {
    const origin = new URL(callback.origin);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const call = request(
        {
          hostname: origin.hostname,
          port: origin.port,
          path: 'http://[',
          method: 'GET',
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      call.on('error', reject);
      call.end();
    });
    assert.equal(status, 400);
  } finally {
    await callback.close();
  }
});

void test('only a well-formed approved return signals the host without reflecting identifiers', async () => {
  const seen: { state: string; token?: string }[] = [];
  const callback = await openDesktopPaypalCallback((value) => {
    seen.push(value);
  });
  const state = 'a'.repeat(43);
  try {
    for (const query of [
      '',
      '?state=invalid',
      `?state=${state}&state=${state}`,
      `?state=${state}&token=ORDER1&token=ORDER2`,
      `?state=${state}&token=bad%20token`,
    ]) {
      await fetch(`${callback.origin}/paypal/approved${query}`);
    }
    await fetch(
      `${callback.origin}/paypal/cancelled?state=${state}&token=ORDER1`,
    );
    assert.deepEqual(seen, []);
    const response = await fetch(
      `${callback.origin}/paypal/approved?state=${state}&token=ORDER1`,
    );
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /ORDER1|aaaaaaaa/);
    await fetch(`${callback.origin}/paypal/approved?state=${state}`);
    assert.deepEqual(seen, [{ state, token: 'ORDER1' }, { state }]);
  } finally {
    await callback.close();
  }
});

void test('only a well-formed cancellation signals the host', async () => {
  const seen: { state: string; token?: string }[] = [];
  const callback = await openDesktopPaypalCallback(undefined, (value) => {
    seen.push(value);
  });
  const state = 'a'.repeat(43);
  try {
    await fetch(`${callback.origin}/paypal/cancelled?state=invalid`);
    await fetch(
      `${callback.origin}/paypal/cancelled?state=${state}&token=bad%20token`,
    );
    assert.deepEqual(seen, []);
    await fetch(
      `${callback.origin}/paypal/cancelled?state=${state}&token=ORDER1`,
    );
    assert.deepEqual(seen, [{ state, token: 'ORDER1' }]);
  } finally {
    await callback.close();
  }
});
