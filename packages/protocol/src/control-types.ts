// Defines versioned free control queries and signed records; no transport or payment execution.
import type {
  CONTROL_AVAILABILITY,
  CONTROL_METHODS,
  CONTROL_PAID_ALPN,
  CONTROL_RECORD_VERSION,
  CONTROL_VERSION,
  ControlCode,
  ControlMeteringMode,
  ReasoningLevel,
  V2_PRICING,
} from './constants.js';
import type { EngineCapabilities, EngineDescription } from './engine.js';
import type {
  PublicCatalog,
  PublicModelListing,
  PublicPresence,
  PublicWithdrawal,
} from './public-types.js';

export interface TokenPricesV2 {
  inputAtomicPerMtok: string;
  outputAtomicPerMtok: string;
}
export interface PublicPricesV2 extends TokenPricesV2 {
  network: string;
  asset: string;
  unit: typeof V2_PRICING.unit;
}
export interface ModelSelection {
  modelId: string;
  variant: string | null;
  quantization: string | null;
}
export interface ControlOfferParams {
  buyer: string;
  buyerNodeId: string;
  selection: ModelSelection;
  reasoning: ReasoningLevel;
  maxTokens: number;
  maxAtomic: string;
  priceCeilings: TokenPricesV2;
  network: string;
  asset: string;
  catalogDigest: string;
}
interface Query {
  version: typeof CONTROL_VERSION;
  requestId: string;
}
export interface CatalogQuery extends Query {
  method: typeof CONTROL_METHODS.CATALOG;
  params: Record<string, never>;
}
export interface PresenceQuery extends Query {
  method: typeof CONTROL_METHODS.PRESENCE;
  params: Record<string, never>;
}
export interface OfferQuery extends Query {
  method: typeof CONTROL_METHODS.OFFER;
  params: ControlOfferParams;
}
export type ControlQuery = CatalogQuery | PresenceQuery | OfferQuery;
export interface PublicModelV2 extends Omit<PublicModelListing, 'pricing'> {
  pricing: PublicPricesV2;
  reasoning: ReasoningLevel[];
}
export interface PublicCatalogV2 extends Omit<
  PublicCatalog,
  'schemaVersion' | 'models'
> {
  schemaVersion: typeof CONTROL_RECORD_VERSION;
  models: PublicModelV2[];
}
export type PublicPresenceV2 = Omit<PublicPresence, 'schemaVersion'> & {
  schemaVersion: typeof CONTROL_RECORD_VERSION;
};
export type PublicWithdrawalV2 = Omit<PublicWithdrawal, 'schemaVersion'> & {
  schemaVersion: typeof CONTROL_RECORD_VERSION;
};
export type PublicRecordV2 =
  PublicCatalogV2 | PublicPresenceV2 | PublicWithdrawalV2;
export interface SignedPublicV2 {
  record: PublicRecordV2;
  signature: string;
}
export interface PublicTrustV2 {
  owner: string;
  nodeId: string;
  now: number;
  lastSequence?: number;
  catalog?: PublicCatalogV2;
}
export interface InferenceOfferV2 {
  schemaVersion: typeof CONTROL_RECORD_VERSION;
  protocol: typeof CONTROL_PAID_ALPN;
  owner: string;
  nodeId: string;
  buyer: string;
  buyerNodeId: string;
  requestId: string;
  requestDigest: string;
  catalogDigest: string;
  selection: ModelSelection;
  reasoning: ReasoningLevel;
  network: string;
  mint: string;
  payTo: string;
  feePayer: string;
  authorizer: string;
  issuedAt: number;
  expiresAt: number;
  endpoint: { relayUrl: string | null; directAddresses: string[] };
  relayOnly: boolean;
  prices: TokenPricesV2;
  maxAtomic: string;
  maxTokens: number;
  model: EngineDescription;
  capabilities: EngineCapabilities;
  meteringMode: ControlMeteringMode;
  availability: { state: typeof CONTROL_AVAILABILITY; observedAt: number };
}
export interface SignedOfferV2 {
  offer: InferenceOfferV2;
  signature: string;
}
export type ControlResponse = {
  version: typeof CONTROL_VERSION;
  requestId: string;
} & (
  | {
      result: {
        method: typeof CONTROL_METHODS.CATALOG;
        catalog: SignedPublicV2;
      };
      error?: never;
    }
  | {
      result: { method: typeof CONTROL_METHODS.OFFER; offer: SignedOfferV2 };
      error?: never;
    }
  | {
      result: {
        method: typeof CONTROL_METHODS.PRESENCE;
        presence: SignedPublicV2;
      };
      error?: never;
    }
  | { error: { code: ControlCode }; result?: never }
);
