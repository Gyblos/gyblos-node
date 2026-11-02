// The token accounts a claim pays into, made to exist before the seller charges: a distribute that
// finds a recipient's account missing pays that share to the program's treasury for good, so payTo,
// the fee treasury, the channel payee and the channel's payer (its refund) are each read and, when
// missing, created at the fee payer's cost in one transaction. No Gyblos imports.
import type { Address, TransactionSigner } from '@solana/kit';

import { UPTO_ERROR_CODES, UPTO_PROGRAM } from './constants';
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
  ): UptoCall<{
    value: readonly ({
      owner: Address;
      data: readonly [string, 'base64'];
    } | null)[];
  }>;
}

export interface UptoTokenAccountsQuery {
  mint: string;
  tokenProgram: string;
  owners: readonly string[];
}

// The owners (each once, in order) with no token account for the mint. An empty system account at
// the address (anyone can send it lamports) is missing too: the associated token program creates
// over it. UNAVAILABLE when the RPC cannot say, or anything else the token program does not own sits
// there, which could never receive a payout.
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
  if (value.length !== owners.length)
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  return owners.filter((_, index) => {
    const found = value[index];
    if (!found) return true;
    if (String(found.owner) === query.tokenProgram) return false;
    if (String(found.owner) === UPTO_PROGRAM.systemProgram && !found.data[0])
      return true;
    throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
  });
}

export interface UptoRecipientAccountsOptions {
  // Pays for each missing account's rent and the transaction fee.
  feePayer: TransactionSigner;
  mint: string;
  tokenProgram: string;
  // Every owner a claim of this seller pays: payTo, the fee treasury and the channel payee.
  owners: readonly string[];
  sleep?: (ms: number) => Promise<void>;
}

export interface UptoRecipientAccounts {
  // Resolves once every owner's account exists, with these too (a channel's payer); UNAVAILABLE (or
  // CHAIN_REJECTED, when the chain refused the creation) otherwise, and the caller must not charge.
  ensure(also?: readonly string[]): Promise<void>;
}

export function createUptoRecipientAccounts(
  rpc: UptoRecipientAccountsRpc,
  options: UptoRecipientAccountsOptions,
): UptoRecipientAccounts {
  const { feePayer, mint, tokenProgram } = options;
  return {
    async ensure(also = []) {
      const missing = await uptoMissingTokenAccounts(rpc, {
        mint,
        tokenProgram,
        owners: [...options.owners, ...also],
      });
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
