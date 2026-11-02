// The token accounts a claim pays into, made to exist before the seller charges: a distribute that
// finds a recipient's account missing pays that share to the program's treasury for good, so payTo,
// the fee treasury, the channel payee and the channel's payer (its refund) are each read and, when
// missing, created at the fee payer's cost in one transaction. Creations run one at a time, so claims
// arriving together do not each pay to create the same account. No Gyblos imports.
import type { Address, TransactionSigner } from '@solana/kit';

import {
  UPTO_ERROR_CODES,
  UPTO_PROGRAM,
  UPTO_TOKEN_ACCOUNT,
} from './constants';
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

// The owners (each once, in order) with no token account for the mint, and those whose account
// could never receive a payout: a token account that is frozen or not initialized, or anything else
// the token program does not own. An empty system account at the address (anyone can send it
// lamports) is missing: the associated token program creates over it. UNAVAILABLE when the RPC
// cannot say.
export async function uptoRecipientTokenAccounts(
  rpc: Pick<UptoRecipientAccountsRpc, 'getMultipleAccounts'>,
  query: UptoTokenAccountsQuery,
): Promise<{ missing: string[]; unusable: string[] }> {
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
  const missing: string[] = [];
  const unusable: string[] = [];
  owners.forEach((owner, index) => {
    const found = value[index];
    if (!found) missing.push(owner);
    else if (String(found.owner) === query.tokenProgram) {
      const state = Buffer.from(found.data[0], 'base64')[
        UPTO_TOKEN_ACCOUNT.stateOffset
      ];
      if (state !== UPTO_TOKEN_ACCOUNT.initialized) unusable.push(owner);
    } else if (
      String(found.owner) === UPTO_PROGRAM.systemProgram &&
      !found.data[0]
    )
      missing.push(owner);
    else unusable.push(owner);
  });
  return { missing, unusable };
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
  const read = async (also: readonly string[]) => {
    const { missing, unusable } = await uptoRecipientTokenAccounts(rpc, {
      mint,
      tokenProgram,
      owners: [...options.owners, ...also],
    });
    if (unusable.length > 0) throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
    return missing;
  };
  // Creations run one at a time and read again first, so claims that found the same account
  // missing together create it once; a check with nothing to create never waits.
  let creating: Promise<unknown> = Promise.resolve();
  async function create(also: readonly string[]) {
    const missing = await read(also);
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
  }
  return {
    async ensure(also = []) {
      if ((await read(also)).length === 0) return;
      const run = creating.then(() => create(also));
      creating = run.catch(() => {});
      await run;
    },
  };
}
