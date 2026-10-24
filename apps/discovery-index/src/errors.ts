// Owns the index's typed rejection and the mapping from protocol ControlError codes to wire codes.
// Messages are static codes only; request input is never echoed or logged.
import { CONTROL_CODES, type ControlCode } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import {
  INDEX_ERRORS,
  INDEX_STATUS,
  type IndexErrorCode,
  type IndexStatus,
} from './constants.js';

const STATUS_OF: ReadonlyMap<IndexErrorCode, IndexStatus> = new Map([
  [INDEX_ERRORS.PUBLISH_NOT_ALLOWED, INDEX_STATUS.FORBIDDEN],
  [INDEX_ERRORS.STALE_RECORD, INDEX_STATUS.CONFLICT],
  [INDEX_ERRORS.PAYLOAD_TOO_LARGE, INDEX_STATUS.PAYLOAD_TOO_LARGE],
  [INDEX_ERRORS.RATE_LIMITED, INDEX_STATUS.TOO_MANY_REQUESTS],
  [INDEX_ERRORS.NOT_FOUND, INDEX_STATUS.NOT_FOUND],
  [INDEX_ERRORS.UNAVAILABLE, INDEX_STATUS.SERVICE_UNAVAILABLE],
]);

// Record verification codes; every other protocol code is a shape failure.
const RECORD_CODE_OF: ReadonlyMap<ControlCode, IndexErrorCode> = new Map([
  [CONTROL_CODES.SIGNATURE, INDEX_ERRORS.INVALID_SIGNATURE],
  [CONTROL_CODES.EXPIRED, INDEX_ERRORS.EXPIRED_RECORD],
]);

export class IndexError extends Error {
  readonly status: IndexStatus;
  constructor(readonly code: IndexErrorCode) {
    super(code);
    this.name = 'IndexError';
    this.status = statusOf(code);
  }
}

export function statusOf(code: IndexErrorCode): IndexStatus {
  return STATUS_OF.get(code) ?? INDEX_STATUS.BAD_REQUEST;
}

export function indexFail(
  code: IndexErrorCode = INDEX_ERRORS.INVALID_RECORD,
): never {
  throw new IndexError(code);
}

// Runs a protocol check and maps its ControlError to a wire code; other errors propagate (503).
export async function protocolStep<T>(
  step: () => T | Promise<T>,
  codeOf: (code: ControlCode) => IndexErrorCode = recordCode,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof ControlError) return indexFail(codeOf(error.code));
    throw error;
  }
}

export function recordCode(code: ControlCode): IndexErrorCode {
  return RECORD_CODE_OF.get(code) ?? INDEX_ERRORS.INVALID_RECORD;
}

// A reference that does not match the stored catalog, whatever the protocol reason.
export function referenceCode(): IndexErrorCode {
  return INDEX_ERRORS.UNKNOWN_CATALOG;
}
