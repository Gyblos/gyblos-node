import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import {
  DEVNET,
  DEVNET_USDC,
} from '../packages/payments-x402/src/constants.js';
import { createFacilitator } from '../packages/payments-x402/src/facilitator.js';
import { registerFacilitatorHttpCases } from './support/facilitator-http-cases.js';
import { registerFacilitatorObserverCases } from './support/facilitator-observer-cases.js';
import { registerFacilitatorPrivacyCases } from './support/facilitator-privacy-cases.js';
import { registerFacilitatorStartupCases } from './support/facilitator-startup-cases.js';
import { registerLoopbackHostCases } from './support/loopback-host-cases.js';
import { registerPrivateLogCases } from './support/private-log-cases.js';
import { registerPrivateLogGuardCases } from './support/private-log-guard-cases.js';
import { registerPrivateLogReclaimCases } from './support/private-log-reclaim-cases.js';
import { registerPrivateLogReviewCases } from './support/private-log-review-cases.js';
import { registerPrivateLogRotationCases } from './support/private-log-rotation-cases.js';
import { registerSignatureFacilitatorCases } from './support/signature-facilitator-cases.js';

test('malformed payment cannot crash the facilitator or reach settlement', async () => {
  const signer = await generateKeyPairSigner();
  const { app, events } = createFacilitator(signer, 'http://127.0.0.1:9', {
    buyer: 'buyer',
    mint: DEVNET_USDC,
    payTo: 'seller',
    authorizer: 'authorizer',
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    for (const payload of [{}, { payload: null }, { payload: 'bad' }]) {
      const response = await fetch(`${url}/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paymentPayload: payload,
          paymentRequirements: {
            network: DEVNET,
            scheme: 'upto',
            asset: DEVNET_USDC,
            payTo: 'seller',
            amount: '10000',
            extra: {
              feePayer: signer.address,
              receiverAuthorizer: 'authorizer',
            },
          },
        }),
      });
      assert.equal(response.status, 400);
    }
    assert.equal((await fetch(`${url}/supported`)).status, 200);
    assert.equal(events.length, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

registerFacilitatorObserverCases();
registerFacilitatorPrivacyCases();
registerFacilitatorHttpCases();
registerPrivateLogCases();
registerPrivateLogGuardCases();
registerPrivateLogReviewCases();
registerPrivateLogReclaimCases();
registerPrivateLogRotationCases();
registerFacilitatorStartupCases();

registerSignatureFacilitatorCases();
registerLoopbackHostCases();
