// Typed node configuration and artifact errors; never includes input contents or credentials.
import type { NodeErrorCode } from './constants';

export interface NodeErrorContext {
  // Zero-based position of the gyblos.toml [[offers]] entry the error is about.
  offer?: number;
}
export class NodeError extends Error {
  // Declared only, so the field is absent when there is no offer.
  declare readonly offer?: number;
  constructor(
    readonly code: NodeErrorCode,
    context: NodeErrorContext = {},
  ) {
    super(code);
    this.name = 'NodeError';
    if (context.offer !== undefined) this.offer = context.offer;
  }
}
