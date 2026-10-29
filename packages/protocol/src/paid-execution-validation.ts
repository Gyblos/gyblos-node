// Shares static paid-execution boundary errors; free-execution and control failures raised by
// shared parsers become the paid code of the same meaning, never free codes on the paid wire.
import {
  FREE_EXECUTION_CODES,
  type FreeExecutionStopReason,
} from './constants';
import type {
  FreeExecutionDelivered,
  FreeExecutionStop,
} from './free-execution-types';
import {
  FreeExecutionError,
  freeExecutionStop,
  rethrowFreeExecution,
} from './free-execution-validation';
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

function paidCodeOf(error: FreeExecutionError): PaidExecutionCode {
  const key = (
    Object.keys(FREE_EXECUTION_CODES) as (keyof typeof FREE_EXECUTION_CODES)[]
  ).find((name) => FREE_EXECUTION_CODES[name] === error.code);
  return key && key in PAID_EXECUTION_CODES
    ? PAID_EXECUTION_CODES[key as keyof typeof PAID_EXECUTION_CODES]
    : PAID_EXECUTION_CODES.INVALID;
}

export function rethrowPaidExecution(error: unknown): never {
  if (error instanceof PaidExecutionError) throw error;
  try {
    return rethrowFreeExecution(error);
  } catch (mapped) {
    if (mapped instanceof FreeExecutionError)
      return paidExecutionFail(paidCodeOf(mapped));
    return paidExecutionFail();
  }
}

export function paidExecutionBoundary<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    return rethrowPaidExecution(error);
  }
}
