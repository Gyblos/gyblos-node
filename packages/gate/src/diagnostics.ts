import { AssertionError } from 'node:assert';

import { GateError } from '@gyblos/payments-x402/chain';
import { GATE_ERROR_CODES } from '@gyblos/payments-x402/constants';

import { ERROR_DIAGNOSTICS, type ErrorDiagnosticCode } from './constants.js';

export function errorDiagnostic(error: unknown): ErrorDiagnosticCode {
  try {
    if (
      error instanceof GateError &&
      Object.values(GATE_ERROR_CODES).some((code) => code === error.code)
    )
      return error.code;
    if (error instanceof AssertionError) return ERROR_DIAGNOSTICS.ASSERTION;
    if (error instanceof SyntaxError) return ERROR_DIAGNOSTICS.RESPONSE_INVALID;
    if (error instanceof Error) {
      if (error.name === 'AbortError') return ERROR_DIAGNOSTICS.ABORTED;
      if (error.name === 'TimeoutError') return ERROR_DIAGNOSTICS.TIMEOUT;
    }
  } catch {
    // A hostile thrown value must not prevent recording an uncertain outcome.
  }
  return ERROR_DIAGNOSTICS.UNKNOWN;
}
