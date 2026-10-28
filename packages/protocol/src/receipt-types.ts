// Defines content-free usage attestations; identity policy and collection stay outside the wire port.
import type {
  ControlMeteringMode,
  EngineDoneReason,
  EngineKind,
  FreeExecutionCode,
  FreeExecutionStopReason,
  OFFER_PRICING_KINDS,
  ReasoningLevel,
  RECEIPT,
  ReceiptDisputeField,
  ReceiptOutcome,
  ReceiptVerdict,
} from './constants';
import type { ModelSelection, TokenPricesV2 } from './control-types';

export interface ReceiptUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
}
export interface ReceiptSizes {
  inputBytes: number;
  outputBytes: number;
  inputChars: number;
  outputChars: number;
}
export interface SellerReceiptV1 {
  version: typeof RECEIPT.version;
  requestId: string;
  requestDigest: string;
  sellerNodeId: string;
  buyerNodeId: string;
  owner: string;
  selection: ModelSelection;
  reasoning: ReasoningLevel;
  engineKind: EngineKind;
  metering: ControlMeteringMode;
  streaming: boolean;
  pricing:
    | { kind: typeof OFFER_PRICING_KINDS.FREE }
    | {
        kind: typeof OFFER_PRICING_KINDS.PAID;
        prices: TokenPricesV2;
        network: string;
        asset: string;
      };
  amountAtomic: string;
  feeAtomic: string;
  usage: ReceiptUsage;
  sizes: ReceiptSizes;
  timing: { receivedAt: number; firstTokenMs: number | null; totalMs: number };
  outcome: ReceiptOutcome;
  code: FreeExecutionCode | null;
  reason: FreeExecutionStopReason | null;
  finishReason: EngineDoneReason | null;
}
export interface BuyerReceiptV1 {
  version: typeof RECEIPT.version;
  requestId: string;
  sellerReceiptDigest: string;
  sellerNodeId: string;
  buyerNodeId: string;
  observed: {
    inputTokens: number | null;
    outputTokens: number | null;
    outputBytes: number;
    firstTokenMs: number | null;
    totalMs: number;
  };
  verdict: ReceiptVerdict;
  disputed: ReceiptDisputeField[];
}
export interface SignedReceipt<T> {
  record: T;
  signature: string;
}
export interface ReceiptV1 {
  seller: SignedReceipt<SellerReceiptV1>;
  buyer?: SignedReceipt<BuyerReceiptV1>;
}
