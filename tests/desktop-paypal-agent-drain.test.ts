import assert from 'node:assert/strict';
import { test } from 'node:test';

import { drainAgentResponse } from '@gyblos/desktop/paypal-agent-drain';

void test('a response is not considered drained until the write callback fires', async () => {
  let finish = () => {};
  let closed = () => {};
  let destroyed = false;
  let done = false;
  const output = {
    end(_text: string, callback: () => void) { finish = callback; },
    onClosed(callback: () => void) { closed = callback; return () => { closed = () => {}; }; },
    destroy() { destroyed = true; closed(); },
  };
  const pending = drainAgentResponse(output, 'synthetic', 5000).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(destroyed, false);
  finish();
  await pending;
  assert.equal(done, true);
  assert.equal(destroyed, false);
});

void test('a stalled response is closed after the bounded drain period', async () => {
  let closed = () => {};
  let destroyed = false;
  const output = {
    end(_text: string, _callback: () => void) {},
    onClosed(callback: () => void) { closed = callback; return () => { closed = () => {}; }; },
    destroy() { destroyed = true; closed(); },
  };
  await drainAgentResponse(output, 'synthetic', 5);
  assert.equal(destroyed, true);
});
