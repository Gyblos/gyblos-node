// Guards the runtime SDK schema contract across security dependency updates.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePaymentPayload } from '@x402/core/schemas';
import { UPTO } from 'x402-upto-metered';

import { DEVNET, DEVNET_USDC } from '@gyblos/config';

void test('x402 SDK parses nonempty authorization and extension records', () => {
  const value = {
    x402Version: UPTO.x402Version,
    accepted: {
      scheme: UPTO.scheme,
      network: DEVNET,
      amount: '1',
      asset: DEVNET_USDC,
      payTo: 'synthetic-recipient',
      maxTimeoutSeconds: 1,
      extra: { feePayer: 'synthetic-fee-payer' },
    },
    payload: { transaction: 'synthetic-unsigned-transaction' },
    extensions: { synthetic: { enabled: true } },
  };
  const parsed = parsePaymentPayload(value);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.deepEqual(parsed.data, value);
  assert.equal(parsePaymentPayload({ ...value, payload: null }).success, false);
});
