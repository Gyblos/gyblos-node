import type { DEVNET, DIAGNOSTIC_LIMITS } from '@gyblos/config';
import type {
  EvidenceAssetLabel,
  EvidenceId,
  EvidenceStatus,
  RECONCILIATION_CLASSIFICATIONS,
  ReconciliationClassification,
  SCHEMA_VERSIONS,
} from '@gyblos/lab-harness/constants';

export interface EvidenceBase {
  schemaVersion: typeof SCHEMA_VERSIONS.EVIDENCE;
  evidenceId: EvidenceId;
  sdkVersion: string;
  network: typeof DEVNET;
  mint: string;
  assetLabel: EvidenceAssetLabel;
  status: EvidenceStatus;
  gatePassed: boolean;
  // Historical attempts may use earlier schemas; preserve their original JSON.
  previousAttempts?: unknown[];
  limitations: string[];
}

export interface AuthorizationMetadata {
  authorizationHash: string;
  buyerSignature: string;
  blockhash: string | undefined;
}

export interface ExactSnapshot {
  buyer: string;
  seller: string;
  buyerLamports: string;
}

export interface ReconciliationObservation {
  checkedAt: string;
  address: string;
  historyLimit: typeof DIAGNOSTIC_LIMITS.transactionHistory;
  matches: { signature: string; slot: number; error: unknown }[];
  classification: Exclude<
    ReconciliationClassification,
    typeof RECONCILIATION_CLASSIFICATIONS.UNAVAILABLE
  >;
}

export type Reconciliation =
  | ReconciliationObservation
  | { classification: typeof RECONCILIATION_CLASSIFICATIONS.UNAVAILABLE };
