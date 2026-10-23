// Signs an exact payment for the buyer or authorizer wallet, journals it before sending, and returns
// the response, receipt, balance snapshots and public calls. Uncertain outcomes throw.
import {
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';

import { HTTP_STATUS } from '@gyblos/config';
import { JOURNAL_STATES } from '@gyblos/payments-x402/constants';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';

import {
  GATE_TIMEOUTS,
  PUBLIC_CALL_OUTCOMES,
  type ExactCaseName,
  type WALLET_ROLES,
} from '../../constants.js';
import { createExactBuyer, validateExactTerms } from '../../exact/index.js';
import { saveJournal } from '../../journal.js';
import { signer } from '../../wallet.js';
import type { createChallenge } from './challenge.js';
import { authorizationMetadata, snapshot } from './reconcile.js';
import type { ActiveAuthorization, ExactContext } from './types.js';

export function createPaidRequest(
  {
    config: config,
    facilitator,
    host,
    url,
    journalPath,
    provider,
  }: ExactContext,
  challenge: ReturnType<typeof createChallenge>,
  policy: Parameters<typeof validateExactTerms>[1],
  setActive: (active: ActiveAuthorization) => void,
) {
  return async function paid(
    role: typeof WALLET_ROLES.BUYER | typeof WALLET_ROLES.AUTHORIZER,
    caseName: ExactCaseName,
  ) {
    const terms = await challenge();
    const before = await snapshot(config, config.addresses[role]);
    const payload = await createExactBuyer(
      await signer(config, role),
      config.rpcUrl,
      policy,
    ).authorize(terms, before.buyer);
    const metadata = authorizationMetadata(payload, config.addresses[role]);
    setActive({ buyer: config.addresses[role], ...metadata });
    await saveJournal(journalPath, {
      state: JOURNAL_STATES.AUTHORIZATION_CREATED,
      case: caseName,
      facilitator: provider.url,
      buyer: config.addresses[role],
      ...metadata,
      before,
      createdAt: new Date().toISOString(),
    });
    const firstCall = facilitator.calls.length;
    const previousHandlers = host.handlerCalls();
    const response = await fetch(url, {
      headers: {
        'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload),
      },
      signal: AbortSignal.timeout(GATE_TIMEOUTS.publicPayment),
    });
    const receiptHeader = response.headers.get('PAYMENT-RESPONSE');
    const receipt = receiptHeader
      ? decodePaymentResponseHeader(receiptHeader)
      : undefined;
    const body = await response.json();
    const after = await snapshot(config, config.addresses[role]);
    const calls = facilitator.calls.slice(firstCall);
    if (
      calls.some((call) => call.outcome === PUBLIC_CALL_OUTCOMES.UNCERTAIN) ||
      response.status >= HTTP_STATUS.internalServerError
    )
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.PUBLIC_OUTCOME_UNCERTAIN,
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
