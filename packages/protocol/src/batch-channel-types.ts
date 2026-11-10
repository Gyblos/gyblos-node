// Typed reusable-session messages; opaque SDK payloads stay private to the financial endpoints.
import type { BATCH_CHANNEL, BATCH_METHODS } from './batch/constants';
import type { SignedOfferV2 } from './control-types';
import type {
  FreeExecutionRequest,
  FreeExecutionResult,
} from './free-execution-types';
import type { PaidExecutionCode } from './paid/constants';
import type {
  SessionBill,
  SessionSettlement,
  SessionSnapshot,
  SessionVoucher,
} from './payment-session';
import type { SessionCode } from './sessions/constants';

export type BatchChannelCode = SessionCode | PaidExecutionCode;
export interface BatchExecutionRequest {
  channelId: string;
  requestId: string;
  quote: SignedOfferV2;
  input: FreeExecutionRequest['input'];
}
interface Header {
  version: typeof BATCH_CHANNEL.version;
  requestId: string;
}
export type BatchChannelRequest = Header &
  (
    | {
        method: typeof BATCH_METHODS.OPEN;
        params: { payload: string; quote: SignedOfferV2 };
      }
    | { method: typeof BATCH_METHODS.EXECUTE; params: BatchExecutionRequest }
    | {
        method: typeof BATCH_METHODS.APPROVE;
        params: { bill: SessionBill; voucher: SessionVoucher };
      }
    | {
        method: typeof BATCH_METHODS.SNAPSHOT | typeof BATCH_METHODS.CLOSE;
        params: { channelId: string };
      }
  );
export type BatchChannelResult =
  | { snapshot: SessionSnapshot }
  | { value: FreeExecutionResult; bill: SessionBill }
  | { settlement: SessionSettlement };
export type BatchChannelResponse = Header & { requestDigest: string } & (
    | { result: BatchChannelResult; error?: never }
    | { error: { code: BatchChannelCode }; result?: never }
  );
