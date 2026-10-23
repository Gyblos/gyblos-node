// Owns ProtocolError: a plain Error carrying a code from PROTOCOL_ERROR_CODES.
// It must not perform RPC, persistence or payment recovery.
import type { ProtocolErrorCode } from './constants.js';

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}
