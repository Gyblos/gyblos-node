// Adapter-owned durable state and SDK ports; opaque payment credentials never cross into UI or logs.
import type {
  MessagePartialSigner,
  TransactionPartialSigner,
} from '@solana/kit';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import type {
  BatchChannelConfig,
  BatchDepositPayload,
  BatchFacilitatorPayload,
} from '@x402/svm';

import type {
  PAYMENT_SESSION,
  PaymentSessionTerms,
  SessionBill,
  SessionRequest,
  SessionSettlement,
  SessionState,
  SessionVoucher,
} from '@gyblos/protocol/payment-session';
import type { SessionBlockIntent } from '@gyblos/protocol/session-blocks';

import type { BATCH_BLOCK_STATE } from './constants';

export interface BatchRequestBlocks {
  baseAtomic: string;
  accepted: SessionBlockIntent | null;
  pending: {
    intent: SessionBlockIntent;
    voucher: SessionVoucher | null;
  } | null;
}

export interface BatchPaths {
  directory: string;
  state: string;
  lock: string;
}
export interface BatchHint {
  blockhash: string;
  lastValidBlockHeight: string;
  slot: string;
}
export interface BatchRecord {
  version: typeof PAYMENT_SESSION.version | typeof BATCH_BLOCK_STATE.version;
  terms: PaymentSessionTerms;
  channelId: string;
  state: SessionState;
  hints: BatchHint | null;
  salt: string;
  opening: BatchDepositPayload | null;
  cumulativeAtomic: string;
  voucher: SessionVoucher | null;
  requests: Record<
    string,
    SessionRequest & { bill: SessionBill | null; accepted: boolean }
  >;
  lastActivity: number;
  closing: BatchFacilitatorPayload | null;
  settlement: SessionSettlement | null;
  pending: Record<string, string>;
  blocks?: Record<string, BatchRequestBlocks>;
}
export interface BatchCommonOptions {
  terms: PaymentSessionTerms;
  paths: BatchPaths;
  now: () => number;
}
export interface BatchBuyerOptions extends BatchCommonOptions {
  payer: TransactionPartialSigner & MessagePartialSigner;
  hints: () => Promise<BatchHint>;
}
export interface BatchFacilitator {
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse>;
}
export interface BatchSellerOptions extends BatchCommonOptions {
  authorizer: MessagePartialSigner;
  // Own SDK facilitator, with durable pending operations supplied through the construction port.
  facilitator: (
    pending: {
      get(key: string): Promise<string | undefined>;
      set(key: string, value: string): Promise<void>;
      delete(key: string): Promise<void>;
      setIfAbsent(key: string, value: string): Promise<boolean>;
      deleteIfEquals(key: string, value: string): Promise<boolean>;
    },
    channel: { channelId: string; config: BatchChannelConfig } | undefined,
  ) => Promise<BatchFacilitator>;
  // Trusted chain observation, not the remote buyer's claim or an HTTP success flag.
  observe: (channelId: string) => Promise<SessionSettlement | undefined>;
  // True only for the finalized original opening message plus exact live channel bindings.
  observeOpening: (
    opening: BatchDepositPayload,
    terms: Readonly<PaymentSessionTerms>,
  ) => Promise<boolean>;
  closing: (channelId: string) => Promise<boolean>;
  idleMs?: number;
  minSettlementAtomic?: string;
  pollMs?: number;
  operationMs?: number;
}

export interface BatchSellerContext {
  blockExecutions: Set<string>;
  options: BatchSellerOptions;
  store: import('./batch-session-store').BatchStore;
  requirements: PaymentRequirements;
  facilitator: BatchFacilitator;
}
