// Strict reusable-session RPC boundary; no SDK, engine, storage or network access.
import type { BatchChannelCode, BatchChannelRequest, BatchChannelResponse } from './batch-channel-types';
import { SESSION_CODES } from './sessions/constants';
export type * from './batch-channel-types';
export { BATCH_CHANNEL, BATCH_METHODS } from './batch/constants';
export class BatchChannelError extends Error {
  constructor(readonly code: BatchChannelCode, readonly remote = false) { super(code); this.name = 'BatchChannelError'; }
}
export function parseBatchChannelRequest(_value: unknown): BatchChannelRequest { throw new BatchChannelError(SESSION_CODES.INVALID); }
export async function batchChannelDigest(_value: BatchChannelRequest): Promise<string> { return ''; }
export async function matchBatchChannelResponse(_value: unknown, _request: BatchChannelRequest): Promise<BatchChannelResponse> { throw new BatchChannelError(SESSION_CODES.INVALID); }
