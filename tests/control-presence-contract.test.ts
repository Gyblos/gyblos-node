// Pins additive presence lookup and response correlation without changing existing control vectors.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_CODES,
  CONTROL_METHODS,
  CONTROL_VERSION,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';
import { parseControlQuery } from '@gyblos/protocol/control-requests';
import { matchControlResponse } from '@gyblos/protocol/control-response';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture';

void test('presence lookup carries a v2 node-signed presence and exact request correlation', async () => {
  const source = await controlFixture();
  const query = parseControlQuery({
    version: CONTROL_VERSION,
    requestId: 'a'.repeat(32),
    method: CONTROL_METHODS.PRESENCE,
    params: {},
  });
  const { models: _models, dataPolicy: _policy, ...header } = source.catalog;
  const presence = await signPublicV2(
    {
      ...header,
      kind: PUBLIC_RECORD_KINDS.PRESENCE,
      sequence: 2,
      catalogDigest: await catalogDigestV2(source.catalog),
      state: PUBLIC_PRESENCE_STATE,
      expiresAt: header.issuedAt + 1000,
    },
    source.nodeSigner,
  );
  assert.equal(
    matchControlResponse(
      {
        version: CONTROL_VERSION,
        requestId: query.requestId,
        result: { method: CONTROL_METHODS.PRESENCE, presence },
      },
      query,
    ).method,
    CONTROL_METHODS.PRESENCE,
  );
  assert.throws(
    () =>
      matchControlResponse(
        {
          version: CONTROL_VERSION,
          requestId: 'b'.repeat(32),
          result: { method: CONTROL_METHODS.PRESENCE, presence },
        },
        query,
      ),
    { code: CONTROL_CODES.POLICY },
  );
});
