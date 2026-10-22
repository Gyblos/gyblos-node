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
