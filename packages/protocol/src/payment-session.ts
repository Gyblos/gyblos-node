// Reusable session ports: buyer approval follows independently verified usage, never a prepaid charge.
// SDK payloads are opaque private values; no engine, filesystem, transport or chain access here.
import {
  SESSION_CODES,
  type SessionCode,
  type SessionState,
} from './sessions/constants';

export type { SessionState, SessionCode } from './sessions/constants';
export {
  PAYMENT_SESSION,
  SESSION_CODES,
  OPENING_STATUS,
  type OpeningStatus,
  SESSION_STATES,
} from './sessions/constants';
// cause: the original failure a generic code replaced, for local diagnostics only; never sent to a peer.
export class PaymentSessionError extends Error {
  constructor(
    readonly code: SessionCode,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = 'PaymentSessionError';
  }
}
export function sessionFail(code: SessionCode = SESSION_CODES.INVALID): never {
  throw new PaymentSessionError(code);
}
export interface PaymentSessionTerms {
  buyer: string;
  buyerNodeId: string;
  owner: string;
  sellerNodeId: string;
  network: string;
  mint: string;
  payTo: string;
  feePayer: string;
  authorizer: string;
  treasury: string;
  protocolFeeBps: number;
  depositAtomic: string;
  expiresAt: number;
  withdrawDelaySeconds: number;
}
export interface SessionRequest {
  requestId: string;
  requestDigest: string;
  maxAtomic: string;
}
export interface SessionBill extends SessionRequest {
  chargedAtomic: string;
  cumulativeAtomic: string;
}
export interface SessionVoucher {
  channelId: string;
  maxClaimableAmount: string;
  expiresAt: number;
  signature: string;
}
export interface SessionSnapshot {
  expiresAt: number;
  channelId: string;
  state: SessionState;
  cumulativeAtomic: string;
  reservedAtomic: string;
}
export interface SessionSettlement {
  channelId: string;
  chargedAtomic: string;
  refundedAtomic: string;
  transaction: string;
}
export interface SessionSeller {
  open(payload: string): Promise<SessionSnapshot>;
  reserve(request: SessionRequest, peer: string): Promise<void>;
  finish(requestId: string, chargedAtomic: string): Promise<SessionBill>;
  accept(
    bill: SessionBill,
    voucher: SessionVoucher,
    peer: string,
  ): Promise<void>;
  close(): Promise<SessionSettlement>;
  tick(): Promise<SessionSettlement | undefined>;
  snapshot(): SessionSnapshot;
  dispose(): Promise<void>;
}
export interface SessionBuyer {
  openingRecovery?: {
    claim(): Promise<boolean>;
    acknowledged(): Promise<void>;
    pending(): boolean;
    status(
      signal: AbortSignal,
    ): Promise<import('./sessions/constants').OpeningStatus>;
  };
  open(check?: () => void): Promise<string>;
  begin(request: SessionRequest): Promise<void>;
  acknowledge(requestId: string): Promise<void>;
  reconcile(
    observe: (channelId: string) => Promise<SessionSettlement | undefined>,
  ): Promise<SessionSettlement | undefined>;
  recoverApproval(): Promise<
    { bill: SessionBill; voucher: SessionVoucher } | undefined
  >;
  approve(bill: SessionBill, verifiedAtomic: string): Promise<SessionVoucher>;
  snapshot(): SessionSnapshot;
  dispose(): Promise<void>;
}
