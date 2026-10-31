// Keeps local collector failures static; never reflects credentials, filesystem paths or receipt contents.
import { LOCAL_COLLECTOR_CODES, type LocalCollectorCode } from './constants';

export class LocalCollectorError extends Error {
  constructor(readonly code: LocalCollectorCode) {
    super(code);
    this.name = 'LocalCollectorError';
  }
}
export function collectorFail(code: LocalCollectorCode): never {
  throw new LocalCollectorError(code);
}
export function collectorInvalid(): never {
  return collectorFail(LOCAL_COLLECTOR_CODES.INVALID);
}
