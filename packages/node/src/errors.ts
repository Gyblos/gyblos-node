// Typed node configuration and artifact errors; never includes input contents or credentials.
import type { NodeErrorCode } from './constants';

export class NodeError extends Error {
  // Position of the gyblos.toml [[offers]] entry the error is about, when there is one.
  declare readonly offer?: number;
  constructor(
    readonly code: NodeErrorCode,
    context: { offer?: number } = {},
  ) {
    super(code);
    this.name = 'NodeError';
    if (context.offer !== undefined)
      Object.assign(this, { offer: context.offer });
  }
}
