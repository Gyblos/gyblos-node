import assert from 'node:assert/strict';
import { test } from 'node:test';

import { restoredSellerAddress } from '@gyblos/buyer/free-selection';
import { primaryRelayUrl } from '@gyblos/transport-iroh/endpoint';

void test('a restored discovered seller has the same approved relay after restart', () => {
  const address = restoredSellerAddress(
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    'owner',
    true,
  );
  assert.equal(
    address.relayUrl()?.replace(/\/$/, ''),
    primaryRelayUrl().replace(/\/$/, ''),
  );
});
