// Shares static paid-execution boundary errors; free-execution and control failures raised by
// shared parsers become the paid code of the same meaning, never free codes on the paid wire.
import {
  CONTROL_CODES,
  FREE_EXECUTION_CODES,
  type ControlCode,
  type FreeExecutionCode,
  type FreeExecutionStopReason,
} from './constants';
import { ControlError } from './control-validation';
import type {
  FreeExecutionDelivered,
  FreeExecutionStop,
} from './free-execution-types';
import {
  FreeExecutionError,
  freeExecutionStop,
} from './free-execution-validation';
import { INFERENCE_CODES, InferenceError } from './inference';
import { PAID_EXECUTION_CODES, type PaidExecutionCode } from './paid/constants';

export class PaidExecutionError extends Error {
  // Declared only: absent fields stay absent rather than own undefined properties.
  declare readonly reason?: FreeExecutionStopReason;
  declare readonly delivered?: FreeExecutionDelivered;
  constructor(
    readonly code: PaidExecutionCode,
    readonly remote = false,
    stop: FreeExecutionStop = {},
  ) {
    super(code);
    this.name = 'PaidExecutionError';
    Object.assign(this, freeExecutionStop(stop));
  }
}

export function paidExecutionFail(
  code: PaidExecutionCode = PAID_EXECUTION_CODES.INVALID,
): never {
  throw new PaidExecutionError(code);
}

// Shared parsers raise free and control codes; each maps to the paid code of the same meaning.
// Free-only admission codes cannot arise on the paid path and map to INVALID.
const FROM_FREE = {
  [FREE_EXECUTION_CODES.INVALID]: PAID_EXECUTION_CODES.INVALID,
  [FREE_EXECUTION_CODES.VERSION]: PAID_EXECUTION_CODES.VERSION,
  [FREE_EXECUTION_CODES.LIMIT]: PAID_EXECUTION_CODES.LIMIT,
  [FREE_EXECUTION_CODES.BINDING]: PAID_EXECUTION_CODES.BINDING,
  [FREE_EXECUTION_CODES.SIGNATURE]: PAID_EXECUTION_CODES.SIGNATURE,
  [FREE_EXECUTION_CODES.EXPIRED]: PAID_EXECUTION_CODES.EXPIRED,
  [FREE_EXECUTION_CODES.PEER]: PAID_EXECUTION_CODES.PEER,
  [FREE_EXECUTION_CODES.REPLAY]: PAID_EXECUTION_CODES.REPLAY,
  [FREE_EXECUTION_CODES.NOT_FREE]: PAID_EXECUTION_CODES.INVALID,
  [FREE_EXECUTION_CODES.DAILY_CAP]: PAID_EXECUTION_CODES.INVALID,
  [FREE_EXECUTION_CODES.BUYER_CAP]: PAID_EXECUTION_CODES.INVALID,
  [FREE_EXECUTION_CODES.UNSUPPORTED]: PAID_EXECUTION_CODES.UNSUPPORTED,
  [FREE_EXECUTION_CODES.BUSY]: PAID_EXECUTION_CODES.BUSY,
  [FREE_EXECUTION_CODES.ENGINE]: PAID_EXECUTION_CODES.ENGINE,
  [FREE_EXECUTION_CODES.TIMEOUT]: PAID_EXECUTION_CODES.TIMEOUT,
  [FREE_EXECUTION_CODES.CANCELLED]: PAID_EXECUTION_CODES.CANCELLED,
  [FREE_EXECUTION_CODES.INTERNAL]: PAID_EXECUTION_CODES.INTERNAL,
  [FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE]:
    PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
} as const satisfies Record<FreeExecutionCode, PaidExecutionCode>;
const FROM_CONTROL: Partial<Record<ControlCode, PaidExecutionCode>> = {
  [CONTROL_CODES.LIMIT]: PAID_EXECUTION_CODES.LIMIT,
  [CONTROL_CODES.SIGNATURE]: PAID_EXECUTION_CODES.SIGNATURE,
  [CONTROL_CODES.EXPIRED]: PAID_EXECUTION_CODES.EXPIRED,
  [CONTROL_CODES.VERSION]: PAID_EXECUTION_CODES.VERSION,
  [CONTROL_CODES.POLICY]: PAID_EXECUTION_CODES.BINDING,
};

export function rethrowPaidExecution(error: unknown): never {
  if (error instanceof PaidExecutionError) throw error;
  if (error instanceof InferenceError)
    return paidExecutionFail(
      error.code === INFERENCE_CODES.LIMIT
        ? PAID_EXECUTION_CODES.LIMIT
        : error.code === INFERENCE_CODES.UNSUPPORTED
          ? PAID_EXECUTION_CODES.UNSUPPORTED
          : PAID_EXECUTION_CODES.INTERNAL,
    );
  if (error instanceof FreeExecutionError)
    return paidExecutionFail(FROM_FREE[error.code]);
  if (error instanceof ControlError)
    return paidExecutionFail(FROM_CONTROL[error.code]);
  return paidExecutionFail();
}

export function paidExecutionBoundary<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    return rethrowPaidExecution(error);
  }
}
