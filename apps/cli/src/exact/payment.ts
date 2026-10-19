import {
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';

import { HTTP_STATUS, TIMEOUTS } from '@gyblos/config';
import { saveJson, signer } from '@gyblos/gate/config';
import { GateError } from '@gyblos/payments-x402/chain';
import {
  createExactBuyer,
  validateExactTerms,
} from '@gyblos/payments-x402/exact/index';

import type { createChallenge } from './challenge.js';
import { authorizationMetadata, snapshot } from './reconcile.js';
import type { ActiveAuthorization, ExactContext } from './types.js';

export function createPaidRequest(
  { c, facilitator, host, url, journalPath, provider }: ExactContext,
  challenge: ReturnType<typeof createChallenge>,
  policy: Parameters<typeof validateExactTerms>[1],
  setActive: (active: ActiveAuthorization) => void,
) {
  return async function paid(role: 'buyer' | 'authorizer', caseName: string) {
    const terms = await challenge(),
      before = await snapshot(c, c.addresses[role]);
    const payload = await createExactBuyer(
      await signer(c, role),
      c.rpcUrl,
      policy,
    ).authorize(terms, before.buyer);
    const metadata = authorizationMetadata(payload, c.addresses[role]);
    setActive({ buyer: c.addresses[role], ...metadata });
    await saveJson(journalPath, {
      state: 'authorization-created',
      case: caseName,
      facilitator: provider.url,
      buyer: c.addresses[role],
      ...metadata,
      before,
      createdAt: new Date().toISOString(),
    });
    const firstCall = facilitator.calls.length,
      previousHandlers = host.handlerCalls();
    const response = await fetch(url, {
      headers: {
        'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload),
      },
      signal: AbortSignal.timeout(TIMEOUTS.publicPayment),
    });
    const receiptHeader = response.headers.get('PAYMENT-RESPONSE');
    const receipt = receiptHeader
      ? decodePaymentResponseHeader(receiptHeader)
      : undefined;
    const body = await response.json();
    const after = await snapshot(c, c.addresses[role]);
    const calls = facilitator.calls.slice(firstCall);
    if (
      calls.some((call) => call.outcome === 'uncertain') ||
      response.status >= HTTP_STATUS.internalServerError
    )
      throw new GateError(
        'PUBLIC_OUTCOME_UNCERTAIN',
        'Public facilitator response is uncertain; reconcile on-chain.',
      );
    return {
      response,
      receipt,
      body,
      before,
      after,
      payload,
      metadata,
      calls,
      previousHandlers,
    };
  };
}
