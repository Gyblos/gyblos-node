// One content-free local record per failed seller channel operation, for `gyblos logs`. Error text can
// hold transactions, addresses or RPC URLs, so only a stable code is kept: the error's own code, or the
// payment SDK's error prefix.
import { randomUUID } from 'node:crypto';

import {
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_OUTCOMES,
} from '@gyblos/runtime/constants';
import {
  diagnosticCause,
  diagnosticRecord,
  type DiagnosticSink,
} from '@gyblos/runtime/diagnostics';

export const SELLER_CHANNEL_DIAGNOSTICS = {
  component: 'seller-channel',
  phase: 'exchange',
  // Neither a code nor an SDK prefix: the cause stays unknown rather than guessed.
  unknownCode: 'SELLER_CHANNEL_FAILED',
} as const;
// `@x402/svm` batch-settlement errors start with this prefix and a fixed name, then free text.
const SDK_ERROR = /^(invalid_batch_settlement_svm_[a-z_]+):/;
const CODE = /^[A-Z][A-Z0-9_]*$/;

function stableCode(error: unknown) {
  try {
    const code =
      error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value
        : undefined;
    if (typeof code === 'string' && CODE.test(code)) return code;
    if (error instanceof Error) {
      const sdk = SDK_ERROR.exec(error.message)?.[1];
      if (sdk) return sdk;
    }
  } catch {
    /* A hostile error never becomes a message. */
  }
  return SELLER_CHANNEL_DIAGNOSTICS.unknownCode;
}

// Runs one operation and records its failure; the error is rethrown unchanged.
export async function reportChannelFailure<T>(
  sink: DiagnosticSink | undefined,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } catch (error) {
    try {
      const record = sink
        ? diagnosticRecord({
            schema: DIAGNOSTIC_FORMAT.schema,
            id: randomUUID(),
            at: new Date().toISOString(),
            version: DIAGNOSTIC_FORMAT.sourceVersion,
            level: DIAGNOSTIC_LEVELS.ERROR,
            component: SELLER_CHANNEL_DIAGNOSTICS.component,
            operation,
            phase: SELLER_CHANNEL_DIAGNOSTICS.phase,
            correlationId: randomUUID(),
            code: stableCode(error),
            outcome: DIAGNOSTIC_OUTCOMES.FAILURE,
            cause: diagnosticCause(error),
            durationMs: Math.max(0, Math.floor(performance.now() - started)),
          })
        : undefined;
      if (record) sink!(record);
    } catch {
      /* Logging never changes the operation's outcome. */
    }
    throw error;
  }
}
