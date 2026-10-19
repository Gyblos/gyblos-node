import assert from 'node:assert/strict';

import { signer } from '@gyblos/gate/config';
import {
  createExactBuyer,
  validateExactTerms,
} from '@gyblos/payments-x402/exact/index';

import type { createChallenge } from './challenge.js';
import { snapshot } from './reconcile.js';
import type { ExactContext } from './types.js';

export async function assertUntrusted(
  { config: config, host, persist, evidence }: ExactContext,
  required: Awaited<ReturnType<ReturnType<typeof createChallenge>>>,
  policy: Parameters<typeof validateExactTerms>[1],
) {
  const cases = evidence.results;
  // Untrusted variants are rejected before the signer or any public payment operation.
  for (const field of ['asset', 'payTo', 'feePayer'] as const) {
    const valid = required.accepts[0]!;
    const changed =
      field === 'feePayer'
        ? {
            ...valid,
            extra: { ...valid.extra, feePayer: config.addresses.buyer },
          }
        : { ...valid, [field]: config.addresses.buyer };
    let signed = false;
    const base = await signer(config, 'buyer');
    const buyer = createExactBuyer(
      {
        ...base,
        async signTransactions() {
          signed = true;
          throw new Error('Untrusted terms reached signer.');
        },
      },
      config.rpcUrl,
      policy,
    );
    await assert.rejects(
      buyer.authorize({ ...required, accepts: [changed] }, '10000'),
      /Exact terms/,
    );
    assert.equal(signed, false);
    cases.push({
      case: `untrusted-${field}`,
      status: 'passed',
      signed: false,
      handlerCalls: host.handlerCalls(),
    });
  }
  await persist();
}

export async function assertEmpty(
  { config: config, host, facilitator, persist, evidence }: ExactContext,
  challenge: ReturnType<typeof createChallenge>,
  policy: Parameters<typeof validateExactTerms>[1],
) {
  const cases = evidence.results;
  // A live zero balance is rejected before signing or contacting public payment endpoints.
  const emptyBefore = await snapshot(config, config.addresses.authorizer),
    emptyCalls = facilitator.calls.length,
    emptyHandlers = host.handlerCalls();
  assert.equal(emptyBefore.buyer, '0');
  let signed = false;
  const emptySigner = await signer(config, 'authorizer');
  const emptyBuyer = createExactBuyer(
    {
      ...emptySigner,
      async signTransactions() {
        signed = true;
        throw new Error('Empty buyer reached signer.');
      },
    },
    config.rpcUrl,
    policy,
  );
  await assert.rejects(
    emptyBuyer.authorize(await challenge(), emptyBefore.buyer),
    /insufficient Circle/,
  );
  assert.equal(signed, false);
  assert.equal(facilitator.calls.length, emptyCalls);
  assert.equal(host.handlerCalls(), emptyHandlers);
  const emptyAfter = await snapshot(config, config.addresses.authorizer);
  assert.deepEqual(emptyAfter, emptyBefore);
  cases.push({
    case: 'insufficient-usdc',
    status: 'passed',
    enforcement: 'buyer-preflight',
    reason: 'INSUFFICIENT_EXACT_USDC',
    signed: false,
    before: emptyBefore,
    after: emptyAfter,
    handlerDelta: 0,
    publicPaymentCalls: 0,
  });
  await persist();
}
