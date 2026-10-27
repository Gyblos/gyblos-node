// Shares static free-execution boundary errors and text bounds; never inspects prompts in messages.
import {
  CONTROL_CODES,
  FREE_EXECUTION_CODES,
  type FreeExecutionCode,
  type FreeExecutionStopReason,
} from './constants';
import { ControlError } from './control-validation';
import type {
  FreeExecutionDelivered,
  FreeExecutionStop,
} from './free-execution-types';

// Copies only the stop fields that are present, so canonical JSON never sees undefined.
export function freeExecutionStop(
  source: FreeExecutionStop,
): FreeExecutionStop {
  return {
    ...(source.reason ? { reason: source.reason } : {}),
    ...(source.delivered
      ? { delivered: { outputTokens: source.delivered.outputTokens } }
      : {}),
  };
}
export class FreeExecutionError extends Error {
  // Declared only: absent fields stay absent rather than own undefined properties.
  declare readonly reason?: FreeExecutionStopReason;
  declare readonly delivered?: FreeExecutionDelivered;
  constructor(
    readonly code: FreeExecutionCode,
    readonly remote = false,
    stop: FreeExecutionStop = {},
  ) {
    super(code);
    this.name = 'FreeExecutionError';
    Object.assign(this, freeExecutionStop(stop));
  }
}
export function freeExecutionFail(
  code: FreeExecutionCode = FREE_EXECUTION_CODES.INVALID,
): never {
  throw new FreeExecutionError(code);
}
export function rethrowFreeExecution(error: unknown): never {
  if (error instanceof FreeExecutionError) throw error;
  if (error instanceof ControlError) {
    if (error.code === CONTROL_CODES.LIMIT)
      return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
    if (error.code === CONTROL_CODES.SIGNATURE)
      return freeExecutionFail(FREE_EXECUTION_CODES.SIGNATURE);
    if (error.code === CONTROL_CODES.EXPIRED)
      return freeExecutionFail(FREE_EXECUTION_CODES.EXPIRED);
    if (error.code === CONTROL_CODES.VERSION)
      return freeExecutionFail(FREE_EXECUTION_CODES.VERSION);
    if (error.code === CONTROL_CODES.POLICY)
      return freeExecutionFail(FREE_EXECUTION_CODES.BINDING);
  }
  return freeExecutionFail();
}
export function freeExecutionBoundary<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    return rethrowFreeExecution(error);
  }
}
export function freeExecutionText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value))
    return freeExecutionFail();
  if (
    value.length > maximum ||
    new TextEncoder().encode(value).length > maximum
  )
    return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
  return value;
}
