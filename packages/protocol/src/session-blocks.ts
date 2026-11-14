// Strict, canonical block exchange; financial persistence and engine execution belong to callers.
import type { BatchChannelCode, BatchExecutionRequest } from './batch-channel';
import type { ExecutionResult } from './free-execution-types';
import type { SessionBill, SessionVoucher } from './payment-session';

import { SESSION_BLOCK_KINDS, SESSION_BLOCKS } from './batch/blocks';

export { SESSION_BLOCK_KINDS, SESSION_BLOCKS } from './batch/blocks';
export interface SessionBlockBinding {
  channelId: string;
  requestId: string;
  requestDigest: string;
}
interface Header extends SessionBlockBinding {
  version: typeof SESSION_BLOCKS.version;
  index: number;
}
export type SessionCheckpoint = Header & {
  kind: typeof SESSION_BLOCK_KINDS.CHECKPOINT;
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  bill: SessionBill;
  terminal: ExecutionResult | null;
};
export type SessionBlockFrame =
  | SessionCheckpoint
  | (Header & {
      kind: typeof SESSION_BLOCK_KINDS.APPROVAL;
      blockDigest: string;
      voucher: SessionVoucher;
    })
  | (Header & {
      kind: typeof SESSION_BLOCK_KINDS.ACK;
      blockDigest: string;
      cumulativeAtomic: string;
    })
  | (Header & {
      kind: typeof SESSION_BLOCK_KINDS.FAILURE;
      code: BatchChannelCode;
    });

export function parseSessionBlock(_value: unknown): SessionBlockFrame {
  throw new Error('not implemented');
}
export function encodeSessionBlock(_value: unknown): Uint8Array {
  return new Uint8Array();
}
export function decodeSessionBlock(_bytes: Uint8Array): SessionBlockFrame {
  throw new Error('not implemented');
}
export async function sessionBlockDigest(_value: unknown): Promise<string> {
  return '';
}
export async function sessionBlockRequestDigest(
  _request: BatchExecutionRequest,
): Promise<string> {
  return '';
}
