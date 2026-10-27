// Typed node configuration and artifact errors; never includes input contents or credentials.
import type { NodeErrorCode } from './constants';

export class NodeError extends Error {
  constructor(readonly code: NodeErrorCode) {
    super(code);
    this.name = 'NodeError';
  }
}
