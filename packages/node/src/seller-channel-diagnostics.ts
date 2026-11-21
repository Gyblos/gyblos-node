// One content-free local record per failed seller channel operation, for `gyblos logs`. Error text can
// hold transactions, addresses or RPC URLs, so only a catalog code is kept: a typed error's code, or the
// payment SDK's error name found on the error or its cause (a session layer may replace it with a
// generic code and keep it as the cause).
import {
  BATCH_SDK_DIAGNOSTIC_CODES,
  batchSdkDiagnosticCode,
} from '@gyblos/payments-upto/batch-session';
import {
  BatchChannelError,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';
import { DIAGNOSTIC_LEVELS } from '@gyblos/runtime/constants';
import {
  createDiagnostics,
  diagnosticCause,
  type DiagnosticSink,
} from '@gyblos/runtime/diagnostics';

import { SELLER_CHANNEL_DIAGNOSTICS as CHANNEL } from './constants';

export type SellerChannelOperation =
  BatchChannelRequest['method'] | typeof CHANNEL.resumeBlock;
const CODES = [
  ...Object.values(SESSION_CODES),
  ...Object.values(PAYMENT_ERROR_CODES),
  ...Object.values(PAID_EXECUTION_CODES),
  ...BATCH_SDK_DIAGNOSTIC_CODES,
  CHANNEL.unknownCode,
];
// Refusals a buyer can cause on purpose stay below the failures that need the operator.
const EXPECTED: readonly string[] = [
  SESSION_CODES.INVALID,
  SESSION_CODES.BINDING,
  SESSION_CODES.BUSY,
  SESSION_CODES.CLOSED,
  SESSION_CODES.LIMIT,
];
function typedCode(error: unknown) {
  if (
    error instanceof PaymentSessionError ||
    error instanceof PaymentError ||
    error instanceof BatchChannelError
  )
    return CODES.find((code) => code === error.code);
}

export function sellerChannelDiagnostics(sink: DiagnosticSink | undefined) {
  const byOperation = new Map<
    SellerChannelOperation,
    ReturnType<typeof create>
  >();
  const create = (operation: SellerChannelOperation) =>
    createDiagnostics({
      component: CHANNEL.component,
      operation,
      phases: [CHANNEL.phase],
      codes: CODES,
      sink,
    });
  // Runs one operation and records its failure; the error is rethrown unchanged.
  return async <T>(
    operation: SellerChannelOperation,
    work: () => Promise<T>,
  ): Promise<T> => {
    if (!sink) return work();
    if (!byOperation.has(operation))
      byOperation.set(operation, create(operation));
    const report = byOperation.get(operation)!.start();
    try {
      return await work();
    } catch (error) {
      try {
        const code =
          batchSdkDiagnosticCode(error) ??
          typedCode(error) ??
          CHANNEL.unknownCode;
        report.report({
          phase: CHANNEL.phase,
          code,
          level: EXPECTED.includes(code)
            ? DIAGNOSTIC_LEVELS.WARN
            : DIAGNOSTIC_LEVELS.ERROR,
          cause: diagnosticCause(error),
        });
      } catch {
        /* Logging never changes the operation's outcome. */
      }
      throw error;
    }
  };
}
