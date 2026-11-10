// Private buyer portfolio ports; each slot retains one original session and independently observed refund.
import type { BatchPoolPaths } from '@gyblos/config/home';
import type { PaymentSessionTerms } from '@gyblos/protocol/payment-session';

import type { openBatchBuyerBackend } from './batch-session-backend';
import type { BatchStoredSession } from './batch-session-state';
import type { BatchPaths } from './batch-session-types';

export interface BatchPoolEntry {
  terms: PaymentSessionTerms;
  legacy: boolean;
  requestId: string | null;
  refundedAtomic: string;
  stored: BatchStoredSession;
}
export interface BatchPoolOptions {
  paths: BatchPoolPaths;
  totalDepositAtomic: string;
  now: () => number;
  backend(paths: BatchPaths): Promise<ReturnType<typeof openBatchBuyerBackend>>;
}
export interface BatchBuyerPool {
  list(): Promise<BatchPoolEntry[]>;
  allocate(terms: PaymentSessionTerms): Promise<BatchPoolEntry>;
  begin(nodeId: string, requestId: string): Promise<void>;
  resolve(nodeId: string): Promise<boolean>;
  backend(nodeId: string): Promise<ReturnType<typeof openBatchBuyerBackend>>;
  budget(): Promise<{ committedAtomic: string; availableAtomic: string }>;
  dispose(): Promise<void>;
}
