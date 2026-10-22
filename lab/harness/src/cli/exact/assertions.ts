import assert from 'node:assert/strict';

import { EXACT_PRICE } from '@gyblos/application/constants';
import { signer } from '@gyblos/lab-harness/config';
import {
  CASE_STATUSES,
  EXACT_CASES,
  EXACT_ENFORCEMENT,
  EXACT_UNTRUSTED_CASES,
  WALLET_ROLES,
} from '@gyblos/lab-harness/constants';
import { GateError } from '@gyblos/payments-x402/chain';
import { GATE_ERROR_CODES } from '@gyblos/payments-x402/constants';
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
    const base = await signer(config, WALLET_ROLES.BUYER);
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
      buyer.authorize({ ...required, accepts: [changed] }, EXACT_PRICE),
      (error: unknown) =>
        error instanceof GateError &&
        error.code === GATE_ERROR_CODES.UNTRUSTED_EXACT_TERMS,
    );
    assert.equal(signed, false);
    cases.push({
      case: EXACT_UNTRUSTED_CASES[field],
      status: CASE_STATUSES.PASSED,
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
  const emptySigner = await signer(config, WALLET_ROLES.AUTHORIZER);
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
    (error: unknown) =>
      error instanceof GateError &&
      error.code === GATE_ERROR_CODES.INSUFFICIENT_EXACT_USDC,
  );
  assert.equal(signed, false);
  assert.equal(facilitator.calls.length, emptyCalls);
  assert.equal(host.handlerCalls(), emptyHandlers);
  const emptyAfter = await snapshot(config, config.addresses.authorizer);
  assert.deepEqual(emptyAfter, emptyBefore);
  cases.push({
    case: EXACT_CASES.INSUFFICIENT_USDC,
    status: CASE_STATUSES.PASSED,
    enforcement: EXACT_ENFORCEMENT.BUYER_PREFLIGHT,
    reason: GATE_ERROR_CODES.INSUFFICIENT_EXACT_USDC,
    signed: false,
    before: emptyBefore,
    after: emptyAfter,
    handlerDelta: 0,
    publicPaymentCalls: 0,
  });
  await persist();
}
