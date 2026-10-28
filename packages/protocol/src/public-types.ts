// Defines public discovery wire contracts, separate from the private paid offer.
// No wallet, registry SDK, endpoint address or engine configuration belongs here.
import type {
  DataRetention,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_PRICE_UNIT,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
  PublicRecordKind,
} from './constants';

export interface PublicRecordHeader {
  schemaVersion: typeof PUBLIC_RECORD_LIMITS.schemaVersion;
  kind: PublicRecordKind;
  owner: string;
  nodeId: string;
  sequence: number;
  issuedAt: number;
  expiresAt: number;
}

export interface PublicModelListing {
  modelId: string;
  variant: string | null;
  quantization: string | null;
  contextTokens: number;
  pricing: {
    network: string;
    asset: string;
    unit: typeof PUBLIC_PRICE_UNIT;
    inputAtomic: string;
    outputAtomic: string;
  };
}

export interface PublicCatalog extends PublicRecordHeader {
  kind: typeof PUBLIC_RECORD_KINDS.CATALOG;
  models: PublicModelListing[];
  dataPolicy: { retention: DataRetention };
}

export interface PublicPresence extends PublicRecordHeader {
  kind: typeof PUBLIC_RECORD_KINDS.PRESENCE;
  catalogDigest: string;
  state: typeof PUBLIC_PRESENCE_STATE;
}

export interface PublicWithdrawal extends PublicRecordHeader {
  kind: typeof PUBLIC_RECORD_KINDS.WITHDRAWAL;
  catalogDigest: string;
}

export type PublicRecord = PublicCatalog | PublicPresence | PublicWithdrawal;

export interface SignedPublicRecord {
  record: PublicRecord;
  signature: string;
}

export interface PublicRecordTrust {
  // Resolve this owner/NodeId binding independently; self-declared identity is not trust.
  owner: string;
  nodeId: string;
  now: number;
  lastSequence?: number;
  // Required for presence/withdrawal; its digest is authenticated by their signature.
  catalog?: PublicCatalog;
}
