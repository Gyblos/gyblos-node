// Unpaid-challenge gate: starts a local facilitator and seller, fetches the fixed route without paying,
// validates the 402 terms and saves evidence that no resource ran and nothing settled. Signs nothing.
import { once } from 'node:events';

import { decodePaymentRequiredHeader } from '@x402/core/http';

import {
  CHALLENGE_EVIDENCE_PATH,
  HTTP_STATUS,
  LOCALHOST,
  MAX_ATOMIC,
  ROUTES,
  X402_SDK_VERSION,
} from '@gyblos/config';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { UPSTREAM_COMMIT } from '@gyblos/payments-x402/constants';
import { createFacilitator } from '@gyblos/payments-x402/facilitator';
import { createGateSeller } from '@gyblos/payments-x402/seller';
import { validateTerms } from '@gyblos/payments-x402/trust';

import { loadConfig, saveJson, signer } from './config.js';
import {
  CHALLENGE_STAGES,
  SCHEMA_VERSIONS,
  WALLET_ROLES,
} from './constants.js';
import type { ChallengeEvidence } from './fixture-evidence-types.js';

export async function challengeGate() {
  const config = await loadConfig();
  await assertProgram(config.rpcUrl);
  const facilitator = createFacilitator(
    await signer(config, WALLET_ROLES.FACILITATOR),
    config.rpcUrl,
    {
      buyer: config.addresses.buyer,
      mint: config.mint,
      payTo: config.addresses.seller,
      authorizer: config.addresses.authorizer,
    },
  );
  const facilitatorServer = facilitator.app.listen(0, LOCALHOST);
  await once(facilitatorServer, 'listening');
  let sellerServer: ReturnType<typeof facilitator.app.listen> | undefined;
  try {
    const address = facilitatorServer.address();
    if (!address || typeof address === 'string')
      throw new Error('No facilitator port.');
    const { app } = await createGateSeller({
      rpcUrl: config.rpcUrl,
      facilitatorUrl: `http://${LOCALHOST}:${address.port}`,
      mint: config.mint,
      payTo: config.addresses.seller,
      authorizer: await signer(config, WALLET_ROLES.AUTHORIZER),
    });
    sellerServer = app.listen(0, LOCALHOST);
    await once(sellerServer, 'listening');
    const sellerAddress = sellerServer.address();
    if (!sellerAddress || typeof sellerAddress === 'string')
      throw new Error('No seller port.');
    const url = `http://${LOCALHOST}:${sellerAddress.port}`;
    const response = await fetch(`${url}${ROUTES.fixed}`);
    if (response.status !== HTTP_STATUS.paymentRequired)
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
      maxAtomic: MAX_ATOMIC,
    });
    const state = (await (await fetch(`${url}${ROUTES.health}`)).json()) as {
      handlerCalls: number;
    };
    if (state.handlerCalls !== 0 || facilitator.events.length !== 0)
      throw new Error('Unpaid request executed resource or settlement.');
    const evidence: ChallengeEvidence = {
      schemaVersion: SCHEMA_VERSIONS.EVIDENCE,
      stage: CHALLENGE_STAGES.UNPAID,
      gatePassed: false,
      createdAt: new Date().toISOString(),
      upstreamCommit: UPSTREAM_COMMIT,
      sdkVersion: X402_SDK_VERSION,
      challenge: terms,
      resourceExecutions: state.handlerCalls,
      settlements: facilitator.events.length,
      note: 'No buyer payment signed or submitted. Does not validate open, claim or refund.',
    };
    await saveJson(CHALLENGE_EVIDENCE_PATH, evidence);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    sellerServer?.close();
    facilitatorServer.close();
  }
}
