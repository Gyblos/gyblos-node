// Enforces one outstanding checkpoint; independent metering and durable approval remain required ports.
import { batchError, batchFail } from './batch-channel-validation';
import type { ExecutionResult } from './free-execution-types';
import { controlAtomic, controlInteger } from './control-validation';
import { SESSION_CODES, type SessionRequest } from './payment-session';
import {
  parseSessionBlock,
  sessionBlockDigest,
  SESSION_BLOCK_KINDS,
  type SessionBlockBinding,
} from './session-blocks';

export interface SessionBlockVerification {
  binding: SessionBlockBinding;
  request: SessionRequest;
  baseAtomic: string;
  depositAtomic: string;
  maxTokens: number;
  verify(text: string, terminal: ExecutionResult | null): Promise<{
    inputTokens: number;
    outputTokens: number;
    chargedAtomic: string;
  }>;
}

export function createSessionBlockVerifier(_options: SessionBlockVerification) {
 return {
  async accept(_value: unknown): Promise<{block: import('./session-blocks').SessionCheckpoint; digest: string}> { throw new Error('not implemented'); },
  acknowledge(_value: unknown): void { throw new Error('not implemented'); },
  finish(): void { throw new Error('not implemented'); },
 };
}
