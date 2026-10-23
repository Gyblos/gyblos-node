// Fetches the exact route unpaid and returns its single 402 option after validating it against policy.
import assert from 'node:assert/strict';

import { decodePaymentRequiredHeader } from '@x402/core/http';

import { HTTP_STATUS } from '@gyblos/config';

import { GATE_TIMEOUTS } from '../../constants.js';
import { validateExactTerms } from '../../exact/index.js';
import type { ExactContext } from './types.js';

export function createChallenge(
  { url }: ExactContext,
  policy: Parameters<typeof validateExactTerms>[1],
) {
  return async function challenge() {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(GATE_TIMEOUTS.publicRequest),
    });
    assert.equal(response.status, HTTP_STATUS.paymentRequired);
    const header = response.headers.get('PAYMENT-REQUIRED');
    assert.ok(header);
    const terms = decodePaymentRequiredHeader(header);
    assert.equal(terms.accepts.length, 1);
    validateExactTerms(terms.accepts[0]!, policy);
    return terms;
  };
}
