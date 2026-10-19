import { once } from 'node:events';

import { decodePaymentRequiredHeader } from '@x402/core/http';

import { assertProgram } from '../../payments-x402/src/chain.js';
import { UPSTREAM_COMMIT } from '../../payments-x402/src/constants.js';
import { createFacilitator } from '../../payments-x402/src/facilitator.js';
import { createGateSeller } from '../../payments-x402/src/seller.js';
import { validateTerms } from '../../payments-x402/src/trust.js';
import { loadConfig, saveJson, signer } from './config.js';

export async function challengeGate() {
  const config = await loadConfig();
  await assertProgram(config.rpcUrl);
  const facilitator = createFacilitator(
    await signer(config, 'facilitator'),
    config.rpcUrl,
    {
      buyer: config.addresses.buyer,
      mint: config.mint,
      payTo: config.addresses.seller,
      authorizer: config.addresses.authorizer,
    },
  );
  const facilitatorServer = facilitator.app.listen(0, '127.0.0.1');
  await once(facilitatorServer, 'listening');
  let sellerServer: ReturnType<typeof facilitator.app.listen> | undefined;
  try {
    const address = facilitatorServer.address();
    if (!address || typeof address === 'string')
      throw new Error('No facilitator port.');
    const { app } = await createGateSeller({
      rpcUrl: config.rpcUrl,
      facilitatorUrl: `http://127.0.0.1:${address.port}`,
      mint: config.mint,
      payTo: config.addresses.seller,
      authorizer: await signer(config, 'authorizer'),
    });
    sellerServer = app.listen(0, '127.0.0.1');
    await once(sellerServer, 'listening');
    const sellerAddress = sellerServer.address();
    if (!sellerAddress || typeof sellerAddress === 'string')
      throw new Error('No seller port.');
    const url = `http://127.0.0.1:${sellerAddress.port}`;
    const response = await fetch(`${url}/api/generate`);
    if (response.status !== 402)
      throw new Error(`Expected 402, received ${response.status}.`);
    const required = response.headers.get('PAYMENT-REQUIRED');
    if (!required) throw new Error('Missing challenge.');
    const challenge = decodePaymentRequiredHeader(required);
    const terms = challenge.accepts[0];
    if (!terms) throw new Error('No payment option.');
    validateTerms(terms, {
      mint: config.mint,
      payTo: config.addresses.seller,
      feePayer: config.addresses.facilitator,
      receiverAuthorizer: config.addresses.authorizer,
      maxAtomic: '10000',
    });
    const state = (await (await fetch(`${url}/health`)).json()) as {
      handlerCalls: number;
    };
    if (state.handlerCalls !== 0 || facilitator.events.length !== 0)
      throw new Error('Unpaid request executed resource or settlement.');
    const evidence = {
      schemaVersion: 1,
      stage: 'unpaid-challenge-only',
      gatePassed: false,
      createdAt: new Date().toISOString(),
      upstreamCommit: UPSTREAM_COMMIT,
      sdkVersion: '2.28.0',
      challenge: terms,
      resourceExecutions: state.handlerCalls,
      settlements: facilitator.events.length,
      note: 'No buyer payment signed or submitted. Does not validate open, claim or refund.',
    };
    await saveJson('.local/devnet/challenge-evidence.json', evidence);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    sellerServer?.close();
    facilitatorServer.close();
  }
}
