// Preserve channel inference error codes when shared wire parsers reject input.
import { batchFail } from './batch-channel-validation';
import {
  CONTROL_CODES,
  FREE_EXECUTION_CODES,
  type ControlCode,
  type FreeExecutionCode,
} from './constants';
import { ControlError } from './control-validation';
import { FreeExecutionError } from './free-execution-validation';
import { INFERENCE_CODES, InferenceError } from './inference';
import { PAID_EXECUTION_CODES, type PaidExecutionCode } from './paid/constants';

function inputFail(
  code: PaidExecutionCode = PAID_EXECUTION_CODES.INVALID,
): never {
  return batchFail(code);
}
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

function rethrowInput(error: unknown): never {
  if (error instanceof InferenceError)
    return inputFail(
      error.code === INFERENCE_CODES.LIMIT
        ? PAID_EXECUTION_CODES.LIMIT
        : error.code === INFERENCE_CODES.UNSUPPORTED
          ? PAID_EXECUTION_CODES.UNSUPPORTED
          : PAID_EXECUTION_CODES.INTERNAL,
    );
  if (error instanceof FreeExecutionError)
    return inputFail(FROM_FREE[error.code]);
  if (error instanceof ControlError) return inputFail(FROM_CONTROL[error.code]);
  return inputFail();
}

export function batchInputBoundary<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    return rethrowInput(error);
  }
}
