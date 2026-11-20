import assert from 'node:assert/strict';
import test from 'node:test';

import { isLoopbackHost } from '@gyblos/runtime/loopback-host';

const REBINDING_HOST = 'attacker.example';
void test('loopback host check accepts only loopback literals with the exact port', () => {
  const port = 4022;
  for (const host of [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `LOCALHOST:${port}`,
    `[::1]:${port}`,
  ])
    assert.equal(isLoopbackHost(host, port), true, host);
  for (const host of [
    undefined,
    '',
    '127.0.0.1',
    'localhost',
    `127.0.0.1:${port + 1}`,
    `localhost:0${port}`,
    `${REBINDING_HOST}:${port}`,
    `127.0.0.1.${REBINDING_HOST}:${port}`,
    `localhost.:${port}`,
    `::1:${port}`,
    `127.0.0.2:${port}`,
  ])
    assert.equal(isLoopbackHost(host, port), false, String(host));
  assert.equal(isLoopbackHost(`127.0.0.1:${port}`, 0), false);
});
