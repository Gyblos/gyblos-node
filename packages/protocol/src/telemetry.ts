// Defines the opt-in telemetry port and content-free event catalog; no implementations or I/O.
import type {
  ControlMeteringMode,
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
// The network path one execution travelled, as the seller's transport last saw it. Unknown means no
// direct or relay path was ever observed and is counted as a defect, never as a normal route.
export const EXECUTION_ROUTES = {
  DIRECT: 'iroh-direct',
  RELAY: 'iroh-relay',
  UNKNOWN: 'unknown',
} as const;
export type ExecutionRoute =
  (typeof EXECUTION_ROUTES)[keyof typeof EXECUTION_ROUTES];
export interface ExecutionPath {
  route: ExecutionRoute;
  // A different known route was observed earlier in the same execution (usually relay, then direct).
  routeChanged: boolean;
}
interface CommonEvent {
  at: number;
  role: P2PRole;
  buyerNodeId: string;
  selection: ModelSelection;
  streaming: boolean;
  meteringMode?: ControlMeteringMode;
}
interface SellerEvent extends CommonEvent {
  requestId: string;
  sellerNodeId: string;
  engineKind: EngineKind | null;
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
        path?: ExecutionPath;
        // The engine's own generation time for the output tokens, when it reports one.
        generationMs?: number;
      }
    | {
        type: typeof TELEMETRY_EVENTS.FAILED;
        code: FreeExecutionCode;
        reason: FreeExecutionStopReason | null;
        totalMs: number;
        delivered?: { outputTokens: number };
        path?: ExecutionPath;
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
        | { sellerNodeId: string; engineKind: EngineKind | null }
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
