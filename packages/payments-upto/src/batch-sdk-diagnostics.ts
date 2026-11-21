// Only pinned SDK codes can leave the adapter. Free text can include private RPC or transaction data.
import type { SettleResponse, VerifyResponse } from '@x402/core/types';

import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import { BATCH_SDK_DIAGNOSTIC_CODES } from './constants';

function fromReason(reason: unknown) {
  if (typeof reason === 'string')
    return BATCH_SDK_DIAGNOSTIC_CODES.find(
      (code) => reason === code || reason.startsWith(code + ':'),
    );
}
function batchSdkReason(reason: unknown) {
  const code = fromReason(reason);
  return code ? new Error(code) : undefined;
}

const MAX_CAUSES = 4;
export function batchSdkDiagnosticCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSES && current instanceof Error; depth++) {
    const code = fromReason(current.message);
    if (code) return code;
    current = current.cause;
  }
}

export function requireVerifiedPayer(verdict: VerifyResponse, payer: string) {
  if (!verdict.isValid || verdict.payer !== payer)
    throw new PaymentSessionError(SESSION_CODES.UNVERIFIED, {
      cause: verdict.isValid
        ? undefined
        : batchSdkReason(verdict.invalidReason),
    });
}
export function requireSettlementResponse(
  response: SettleResponse,
  network: string,
) {
  if (
    !response.success ||
    response.network !== network ||
    !response.transaction
  )
    throw new PaymentSessionError(SESSION_CODES.UNAVAILABLE, {
      cause: response.success
        ? undefined
        : batchSdkReason(response.errorReason),
    });
}
