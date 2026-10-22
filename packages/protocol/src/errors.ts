// Owns the shared coded error constructor and preserves Error's legacy shape.
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
