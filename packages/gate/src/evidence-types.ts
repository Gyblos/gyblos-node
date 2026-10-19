export interface EvidenceBase {
  schemaVersion: number;
  evidenceId: string;
  sdkVersion: string;
  network: string;
  mint: string;
  assetLabel: string;
  status: string;
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
  historyLimit: number;
  matches: { signature: string; slot: number; error: unknown }[];
  classification: string;
}

export type Reconciliation =
  ReconciliationObservation | { classification: 'reconciliation-unavailable' };
