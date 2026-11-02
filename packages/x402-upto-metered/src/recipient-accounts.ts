// The token accounts a claim pays into, made to exist before the seller charges: a distribute that
// finds a recipient's account missing pays that share to the program's treasury for good, so payTo,
// the fee treasury and the channel payee are each read and, when missing, created at the fee
// payer's cost in one transaction. No Gyblos imports.
import type { Address, TransactionSigner } from '@solana/kit';

import { UPTO_ERROR_CODES } from './constants';
import { UptoError } from './errors';
import {
  uptoConfirmed,
  uptoRead,
  uptoSend,
  type UptoCall,
  type UptoConfirmed,
  type UptoSendRpc,
} from './transactions';
import {
  tokenAccountInstruction,
  uptoTokenAccount,
} from './withdraw-instructions';

export interface UptoRecipientAccountsRpc extends UptoSendRpc {
  getMultipleAccounts(
    accounts: Address[],
    config: UptoConfirmed & { encoding: 'base64' },
  ): UptoCall<{ value: readonly ({ owner: Address } | null)[] }>;
}

export interface UptoTokenAccountsQuery {
  mint: string;
  tokenProgram: string;
  owners: readonly string[];
}

// The owners (each once, in order) with no token account for the mint; UNAVAILABLE when the RPC
// cannot say, or something the token program does not own sits at an account's address (only the
// associated token program can create one there, so it could never receive a payout).
export async function uptoMissingTokenAccounts(
  rpc: Pick<UptoRecipientAccountsRpc, 'getMultipleAccounts'>,
  query: UptoTokenAccountsQuery,
): Promise<string[]> {
  const owners = [...new Set(query.owners)];
  const accounts = await Promise.all(
    owners.map((owner) =>
      uptoTokenAccount(owner, query.mint, query.tokenProgram),
    ),
  );
  const { value } = await uptoRead(
    rpc.getMultipleAccounts(accounts, { ...uptoConfirmed, encoding: 'base64' }),
  );
  if (
    value.length !== owners.length ||
    value.some((found) => found && String(found.owner) !== query.tokenProgram)
  )
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  return owners.filter((_, index) => !value[index]);
}

export interface UptoRecipientAccountsOptions {
  // Pays for each missing account's rent and the transaction fee.
  feePayer: TransactionSigner;
  mint: string;
  tokenProgram: string;
  // Every owner a claim may pay: payTo, the fee treasury and the channel payee.
  owners: readonly string[];
  sleep?: (ms: number) => Promise<void>;
}

export interface UptoRecipientAccounts {
  // Resolves once every owner's account exists; UNAVAILABLE (or CHAIN_REJECTED, when the chain
  // refused the creation) otherwise, and the caller must not charge.
  ensure(): Promise<void>;
}

export function createUptoRecipientAccounts(
  rpc: UptoRecipientAccountsRpc,
  options: UptoRecipientAccountsOptions,
): UptoRecipientAccounts {
  const { feePayer, mint, tokenProgram } = options;
  return {
    async ensure() {
      const missing = await uptoMissingTokenAccounts(rpc, options);
      if (missing.length === 0) return;
      const { confirmed } = await uptoSend(
        rpc,
        feePayer,
        await Promise.all(
          missing.map((owner) =>
            tokenAccountInstruction(feePayer, owner, mint, tokenProgram),
          ),
        ),
        options.sleep,
      );
      if (!confirmed) throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
    },
  };
}
