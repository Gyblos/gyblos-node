// Duplex block I/O ports: policy verifies independently and financial callers persist signatures/ACKs.
import type { SessionVoucher } from '@gyblos/protocol/payment-session';
import type {
  SessionBlockIntent,
  SessionBlockVerification,
  SessionCheckpoint,
} from '@gyblos/protocol/session-blocks';

export interface BatchBlockClient {
  verification: SessionBlockVerification;
  approve(intent: SessionBlockIntent, check: () => void): Promise<SessionVoucher>;
  acknowledge(intent: SessionBlockIntent): Promise<void>;
}
export type BatchBlockExchange = (
  checkpoint: SessionCheckpoint,
  accept: (voucher: SessionVoucher) => Promise<void>,
) => Promise<void>;
