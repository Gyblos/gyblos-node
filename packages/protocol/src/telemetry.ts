// Defines the opt-in telemetry port and content-free event catalog; no implementations or I/O.
import type {
  EngineDoneReason,
  EngineKind,
  FreeExecutionCode,
  FreeExecutionStopReason,
  P2PRole,
} from './constants';
import type { ModelSelection } from './control-types';
import type { ReceiptSizes, ReceiptUsage, ReceiptV1 } from './receipt-types';

export const TELEMETRY_EVENTS = {
  REQUEST_RECEIVED: 'request_received',
  FIRST_TOKEN: 'first_token',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CHARGED: 'charged',
  RECEIPT: 'receipt',
  REFUSED: 'refused',
  UNSERVED: 'unserved',
} as const;
export type TelemetryEventType =
  (typeof TELEMETRY_EVENTS)[keyof typeof TELEMETRY_EVENTS];
export const TELEMETRY_REFUSALS = {
  SELLER_BUSY: 'seller_busy',
  DAILY_CAP: 'daily_cap',
  BUYER_CAP: 'buyer_cap',
  QUOTE_REJECTED: 'quote_rejected',
  CONNECT_FAILED: 'connect_failed',
  ENGINE_NOT_READY: 'engine_not_ready',
} as const;
export type TelemetryRefusal =
  (typeof TELEMETRY_REFUSALS)[keyof typeof TELEMETRY_REFUSALS];
interface CommonEvent {
  at: number;
  role: P2PRole;
  buyerNodeId: string;
  selection: ModelSelection;
  streaming: boolean;
}
interface SellerEvent extends CommonEvent {
  requestId: string;
  sellerNodeId: string;
  engineKind: EngineKind;
}
type LocatedEvent = SellerEvent &
  (
    | { type: typeof TELEMETRY_EVENTS.REQUEST_RECEIVED }
    | { type: typeof TELEMETRY_EVENTS.FIRST_TOKEN; firstTokenMs: number }
    | {
        type: typeof TELEMETRY_EVENTS.COMPLETED;
        usage: ReceiptUsage;
        sizes: ReceiptSizes;
        totalMs: number;
        finishReason: EngineDoneReason;
      }
    | {
        type: typeof TELEMETRY_EVENTS.FAILED;
        code: FreeExecutionCode;
        reason: FreeExecutionStopReason | null;
        totalMs: number;
        delivered?: { outputTokens: number };
      }
    | {
        type: typeof TELEMETRY_EVENTS.CHARGED;
        amountAtomic: string;
        feeAtomic: string;
        network: string;
        asset: string;
      }
    | { type: typeof TELEMETRY_EVENTS.RECEIPT; receipt: ReceiptV1 }
  );
export type TelemetryEvent =
  | LocatedEvent
  | (CommonEvent & {
      type: typeof TELEMETRY_EVENTS.REFUSED;
      requestId: string;
      refusal: TelemetryRefusal;
    } & (
        | { sellerNodeId: string; engineKind: EngineKind }
        | { sellerNodeId: null; engineKind: null }
      ))
  | (CommonEvent & {
      type: typeof TELEMETRY_EVENTS.UNSERVED;
      requestId: null;
      sellerNodeId: null;
      engineKind: null;
    });
export interface TelemetryHealth {
  emitted: number;
  dropped: number;
  failed: boolean;
}
export interface TelemetrySink {
  // Synchronous and observational: implementations never throw to the caller.
  emit(event: TelemetryEvent): void;
  flush(): Promise<void>;
  close(): Promise<TelemetryHealth>;
}
