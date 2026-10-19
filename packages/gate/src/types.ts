import type { Measurement } from './measurements.js';

export interface TokenAccount {
  owner: string;
  lamports: number;
  data: {
    parsed: {
      info: {
        owner: string;
        mint: string;
        tokenAmount: { amount: string; decimals: number };
      };
    };
  };
}

export interface AccountsResponse {
  context: { slot: number };
  value: (TokenAccount | null)[];
}

export interface ParsedInstruction {
  type: string;
  info: {
    instructions: ParsedInstruction[];
    source: string;
    destination: string;
    mint: string;
    tokenAmount: { amount: string };
  };
}

export interface ChainInstruction {
  programId: string;
  parsed?: ParsedInstruction;
}

export interface ChainTransaction {
  slot: number;
  meta: {
    err: unknown;
    innerInstructions?: { instructions: ChainInstruction[] }[];
    [key: string]: unknown;
  };
  transaction: {
    signatures: string[];
    message: {
      instructions: ChainInstruction[];
      accountKeys: { pubkey: string; signer: boolean; writable: boolean }[];
    };
  };
}

export interface CaseResult {
  case?: string;
  status?: string;
  measurement?: Measurement;
  [key: string]: unknown;
}

export interface GateEvidence {
  schemaVersion: number;
  evidenceId: string;
  sdkVersion: string;
  network: string;
  mint: string;
  assetLabel: string;
  status: string;
  gatePassed: boolean;
  results: CaseResult[];
  previousAttempts?: unknown[];
  facilitators?: unknown[];
  limitations: string[];
  [key: string]: unknown;
}
