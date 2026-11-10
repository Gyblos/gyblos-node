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
  PaymentSessionTerms,
  SessionBill,
  SessionRequest,
  SessionSettlement,
  SessionState,
  SessionVoucher,
} from '@gyblos/protocol/payment-session';

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
  version: number;
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
  closing: (channelId: string) => Promise<boolean>;
  idleMs?: number;
  minSettlementAtomic?: string;
  pollMs?: number;
  operationMs?: number;
}

export interface BatchSellerContext {
  options: BatchSellerOptions;
  store: import('./batch-session-store').BatchStore;
  requirements: PaymentRequirements;
  facilitator: BatchFacilitator;
}
