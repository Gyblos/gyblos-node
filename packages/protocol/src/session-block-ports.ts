// Durable checkpoint ports contain financial metadata only; never text, prompts or tool arguments.
import {
  batchBill,
  batchBoundary,
  batchFail,
} from './batch-channel-validation';
import { SESSION_BLOCKS } from './batch/blocks';
import type { SessionBlockApproval } from './session-block-wire';
import { BATCH_CHANNEL } from './batch/constants';
import { PUBLIC_RECORD_LIMITS } from './constants';
import {
  controlHex,
  controlInteger,
  controlObject,
} from './control-validation';
import type {
  SessionBill,
  SessionBuyer,
  SessionRequest,
  SessionSeller,
  SessionVoucher,
} from './payment-session';

export interface SessionBlockIntent {
  index: number;
  digest: string;
  usage: { inputTokens: number; outputTokens: number };
  bill: SessionBill;
  terminal: boolean;
}
export interface SessionBlockBuyer extends SessionBuyer {
  pendingBlockRequest(): SessionRequest | undefined;
  beginBlocks(request: SessionRequest): Promise<void>;
  approveBlock(
    intent: SessionBlockIntent,
    verifiedAtomic: string,
    check?: () => void,
  ): Promise<SessionVoucher>;
  acknowledgeBlock(intent: SessionBlockIntent): Promise<void>;
  recoverBlockApproval(): Promise<
    { intent: SessionBlockIntent; voucher: SessionVoucher } | undefined
  >;
}
export interface SessionBlockSeller extends SessionSeller {
  resumeBlock(approval: SessionBlockApproval, peer: string): Promise<SessionBlockIntent>;
  reserveBlocks(request: SessionRequest, peer: string): Promise<void>;
  checkpoint(intent: SessionBlockIntent): Promise<void>;
  acceptBlock(
    intent: SessionBlockIntent,
    voucher: SessionVoucher,
    peer: string,
  ): Promise<void>;
  releaseBlocks(requestId: string): Promise<void>;
}
export function parseSessionBlockIntent(value: unknown): SessionBlockIntent {
  return batchBoundary(() => {
    const row = controlObject(value, [
      'index',
      'digest',
      'usage',
      'bill',
      'terminal',
    ]);
    const usage = controlObject(row.usage, ['inputTokens', 'outputTokens']);
    if (typeof row.terminal !== 'boolean') return batchFail();
    return {
      index: controlInteger(row.index, 0, SESSION_BLOCKS.maxBlocks - 1),
      digest: controlHex(row.digest),
      usage: {
        inputTokens: controlInteger(
          usage.inputTokens,
          1,
          PUBLIC_RECORD_LIMITS.maxContextTokens,
        ),
        outputTokens: controlInteger(
          usage.outputTokens,
          0,
          BATCH_CHANNEL.maxOutputTokens,
        ),
      },
      bill: batchBill(row.bill),
      terminal: row.terminal,
    };
  });
}
