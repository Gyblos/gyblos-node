// Keeps public advertisement explicitly opt-in and reuses the adapter URL boundary.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCOVERY_INDEX_URL } from '@gyblos/config';
import { sellerPublicationConfig } from '@gyblos/node/publisher-config';

void test('seller publication is opt-in, defaults to the configured index and rejects unsafe targets', () => {
  assert.equal(sellerPublicationConfig({}), undefined);
  assert.equal(
    sellerPublicationConfig({ GYBLOS_DISCOVERY_PUBLISH: '0' }),
    undefined,
  );
  assert.deepEqual(sellerPublicationConfig({ GYBLOS_DISCOVERY_PUBLISH: '1' }), {
    baseUrl: DISCOVERY_INDEX_URL,
  });
  assert.deepEqual(
    sellerPublicationConfig({
      GYBLOS_DISCOVERY_PUBLISH: '1',
      GYBLOS_DISCOVERY_URL: 'http://127.0.0.1:1234/v1',
    }),
    { baseUrl: 'http://127.0.0.1:1234/v1' },
  );
  for (const url of [
    'http://public.example/v1',
    'https://user:password@index.test/v1',
    'https://index.test/v1?secret=x',
    'invalid',
  ])
    assert.throws(() =>
      sellerPublicationConfig({
        GYBLOS_DISCOVERY_PUBLISH: '1',
        GYBLOS_DISCOVERY_URL: url,
      }),
    );
  assert.throws(() =>
    sellerPublicationConfig({ GYBLOS_DISCOVERY_PUBLISH: 'true' }),
  );
});
