// Owns the collector's typed rejection and the mapping from protocol and core codes to wire codes.
// Messages are static codes only; request input is never echoed or logged.
import { RECEIPT_COLLECTOR_CODES } from '@gyblos/core/constants';
import { ReceiptCollectorError } from '@gyblos/core/receipt-collector';
import { CONTROL_CODES, type ControlCode } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import {
  COLLECTOR_ERRORS,
  COLLECTOR_STATUS,
  type CollectorErrorCode,
  type CollectorStatus,
} from './constants';

export class CollectorError extends Error {
  constructor(readonly code: CollectorErrorCode) {
    super(code);
    this.name = 'CollectorError';
  }
}
export function collectorReject(
  code: CollectorErrorCode = COLLECTOR_ERRORS.INVALID_UPLOAD,
): never {
  throw new CollectorError(code);
}

const STATUS_OF: ReadonlyMap<CollectorErrorCode, CollectorStatus> = new Map([
  [COLLECTOR_ERRORS.STALE_UPLOAD, COLLECTOR_STATUS.CONFLICT],
  [COLLECTOR_ERRORS.REPLAYED_UPLOAD, COLLECTOR_STATUS.CONFLICT],
  [COLLECTOR_ERRORS.PAYLOAD_TOO_LARGE, COLLECTOR_STATUS.PAYLOAD_TOO_LARGE],
  [COLLECTOR_ERRORS.RATE_LIMITED, COLLECTOR_STATUS.TOO_MANY_REQUESTS],
  [COLLECTOR_ERRORS.NOT_FOUND, COLLECTOR_STATUS.NOT_FOUND],
  [COLLECTOR_ERRORS.UNAVAILABLE, COLLECTOR_STATUS.SERVICE_UNAVAILABLE],
]);
export function statusOf(code: CollectorErrorCode): CollectorStatus {
  return STATUS_OF.get(code) ?? COLLECTOR_STATUS.BAD_REQUEST;
}

const CONTROL_CODE_OF: ReadonlyMap<ControlCode, CollectorErrorCode> = new Map([
  [CONTROL_CODES.SIGNATURE, COLLECTOR_ERRORS.INVALID_SIGNATURE],
  [CONTROL_CODES.POLICY, COLLECTOR_ERRORS.UPLOAD_POLICY],
  [CONTROL_CODES.VERSION, COLLECTOR_ERRORS.UNSUPPORTED_VERSION],
  [CONTROL_CODES.LIMIT, COLLECTOR_ERRORS.PAYLOAD_TOO_LARGE],
]);
// Maps verification failures to static wire codes; anything unexpected is rethrown.
export function verificationFailure(error: unknown): never {
  if (error instanceof CollectorError) throw error;
  if (error instanceof ControlError)
    return collectorReject(
      CONTROL_CODE_OF.get(error.code) ?? COLLECTOR_ERRORS.INVALID_UPLOAD,
    );
  if (error instanceof ReceiptCollectorError)
    return collectorReject(
      error.code === RECEIPT_COLLECTOR_CODES.DISPUTE
        ? COLLECTOR_ERRORS.INCONSISTENT_DISPUTE
        : COLLECTOR_ERRORS.INVALID_UPLOAD,
    );
  throw error;
}
