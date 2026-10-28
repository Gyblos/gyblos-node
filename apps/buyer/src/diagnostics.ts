// Maps any thrown value to a fixed diagnostic code, so logs and measurements never carry error text.
import { AssertionError } from 'node:assert';

import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';

import { ERROR_DIAGNOSTICS, type ErrorDiagnosticCode } from './constants';

export function errorDiagnostic(error: unknown): ErrorDiagnosticCode {
  try {
    if (error instanceof ProtocolError) {
      const candidate = error.code;
      const canonical = Object.values(PROTOCOL_ERROR_CODES).find(
        (code) => code === candidate,
      );
      if (canonical) return canonical;
    }
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
