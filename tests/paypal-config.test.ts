import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paypalSandboxSettings } from '@gyblos/config/paypal';

void test('sandbox operator can choose a local port and Ollama origin', () => {
  assert.deepEqual(paypalSandboxSettings({ PAYPAL_SANDBOX_PORT: '8766', PAYPAL_SANDBOX_OLLAMA_ORIGIN: 'http://127.0.0.1:11435/' }),
    { port: 8766, ollamaOrigin: 'http://127.0.0.1:11435/' });
  assert.throws(() => paypalSandboxSettings({ PAYPAL_SANDBOX_PORT: '99999' }));
  assert.throws(() => paypalSandboxSettings({ PAYPAL_SANDBOX_OLLAMA_ORIGIN: 'https://example.com/' }));
});
