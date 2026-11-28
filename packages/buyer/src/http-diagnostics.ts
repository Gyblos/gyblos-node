// Content-free observations of the compatibility boundary. Logging never decides retry or admission.
import type { ServerResponse } from 'node:http';

import { BuyerRoutingError } from '@gyblos/core/buyer-routing';
import { BUYER_ROUTING_CODES } from '@gyblos/core/constants';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import { UnsentSellerBusyError } from '@gyblos/node/buyer-routing';
import { UnsentChannelRequestError } from '@gyblos/node/buyer-session';
import {
  BATCH_SDK_DIAGNOSTIC_CODES,
  batchSdkDiagnosticCode,
} from '@gyblos/payments-upto/batch-session';
import { BatchChannelError } from '@gyblos/protocol/batch-channel';
import {
  BUYER_KEY_CODES,
  BuyerApiKeyError,
} from '@gyblos/protocol/buyer-api-keys';
import {
  FREE_EXECUTION_CODES,
  PAYMENT_ERROR_CODES,
  PROTOCOL_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { FreeExecutionError } from '@gyblos/protocol/free-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';
import {
  DIAGNOSTIC_CAUSES,
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_OUTCOMES,
} from '@gyblos/runtime/constants';
import {
  createDiagnostics,
  diagnosticCause,
  type DiagnosticSink,
} from '@gyblos/runtime/diagnostics';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import {
  BUYER_HTTP_DIAGNOSTICS,
  ERROR_DIAGNOSTICS,
  FREE_BUYER_CODES,
  PAID_BUYER_CODES,
} from './constants';
import { errorDiagnostic } from './diagnostics';
import { FreeBuyerError } from './free-chat';
import { AfterFreeDispatch } from './free-chat-error';

const CODES = [
  ...Object.values(PROTOCOL_ERROR_CODES),
  ...Object.values(ERROR_DIAGNOSTICS),
  ...Object.values(FREE_EXECUTION_CODES),
  ...Object.values(FREE_BUYER_CODES),
  ...Object.values(PAID_BUYER_CODES),
  ...Object.values(BUYER_HTTP_DIAGNOSTICS.codes),
  ...Object.values(SESSION_CODES),
  ...Object.values(PAYMENT_ERROR_CODES),
  ...Object.values(PAID_EXECUTION_CODES),
  ...Object.values(BUYER_ROUTING_CODES),
  ...Object.values(BUYER_KEY_CODES),
  ...BATCH_SDK_DIAGNOSTIC_CODES,
];
function failureCode(error: unknown) {
  try {
    // A paid failure's payment SDK name, even behind a generic session code, says where the channel
    // failed; only catalog names are read, never the text.
    const sdk = batchSdkDiagnosticCode(error);
    if (sdk) return sdk;
    if (
      error instanceof FreeBuyerError ||
      error instanceof FreeClientError ||
      error instanceof FreeExecutionError ||
      error instanceof PaymentSessionError ||
      error instanceof PaymentError ||
      error instanceof BatchChannelError ||
      error instanceof PaidBuyerError ||
      error instanceof BuyerRoutingError ||
      error instanceof UnsentSellerBusyError ||
      error instanceof UnsentChannelRequestError ||
      error instanceof BuyerApiKeyError
    ) {
      const code: unknown = error.code;
      const known = CODES.find((item) => item === code);
      if (known) return known;
    }
  } catch {
    /* Untrusted thrown values are unknown. */
  }
  return errorDiagnostic(error);
}
export function httpDiagnostics(sink?: DiagnosticSink) {
  const channel = createDiagnostics({
    ...BUYER_HTTP_DIAGNOSTICS,
    phases: Object.values(BUYER_HTTP_DIAGNOSTICS.phases),
    codes: CODES,
    level: DIAGNOSTIC_LEVELS.DEBUG,
    sink,
  });
  return () => {
    const operation = channel.start();
    let phase: (typeof BUYER_HTTP_DIAGNOSTICS.phases)[keyof typeof BUYER_HTTP_DIAGNOSTICS.phases] =
      BUYER_HTTP_DIAGNOSTICS.phases.ADMISSION;
    let terminal = false;
    const report = (event: Parameters<typeof operation.report>[0]) => {
      if (terminal) return;
      terminal = true;
      operation.report(event);
    };
    return {
      input: () => {
        phase = BUYER_HTTP_DIAGNOSTICS.phases.INPUT;
      },
      refused: () =>
        report({
          phase,
          code: BUYER_HTTP_DIAGNOSTICS.codes.REFUSED,
          level: DIAGNOSTIC_LEVELS.WARN,
        }),
      executing: () => {
        phase = BUYER_HTTP_DIAGNOSTICS.phases.EXECUTE;
      },
      responding: () => {
        phase = BUYER_HTTP_DIAGNOSTICS.phases.RESPONSE;
      },
      failure: (error: unknown) =>
        report({
          phase,
          code: failureCode(
            error instanceof AfterFreeDispatch ? error.subsequent : error,
          ),
          cause: diagnosticCause(error),
        }),
      timeout: () =>
        report({
          phase,
          code: ERROR_DIAGNOSTICS.TIMEOUT,
          cause: DIAGNOSTIC_CAUSES.TIMEOUT,
          outcome: DIAGNOSTIC_OUTCOMES.TIMEOUT,
        }),
      cancelled: () =>
        report({
          phase,
          code: BUYER_HTTP_DIAGNOSTICS.codes.CLOSED,
          cause: DIAGNOSTIC_CAUSES.ABORT,
          outcome: DIAGNOSTIC_OUTCOMES.CANCELLED,
          level: DIAGNOSTIC_LEVELS.WARN,
        }),
      success: () =>
        report({
          phase,
          code: BUYER_HTTP_DIAGNOSTICS.codes.COMPLETE,
          outcome: DIAGNOSTIC_OUTCOMES.SUCCESS,
          level: DIAGNOSTIC_LEVELS.DEBUG,
        }),
    };
  };
}

// Owns only lifecycle listeners added at the HTTP boundary; expiration remains the caller's policy.
export function httpRequestLifecycle(
  response: ServerResponse,
  requestMs: number,
  diagnostic: ReturnType<ReturnType<typeof httpDiagnostics>>,
  expire: (cancel: () => void) => void,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const disconnected = () => {
    if (!response.writableEnded) diagnostic.cancelled();
    cancel();
  };
  const timer = setTimeout(() => {
    diagnostic.timeout();
    expire(cancel);
  }, requestMs);
  response.once('close', disconnected);
  return {
    controller,
    close() {
      clearTimeout(timer);
      response.removeListener('close', disconnected);
    },
  };
}
