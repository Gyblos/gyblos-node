// The token accounts a seller's paid claim pays into (payout, protocol fee treasury and fee payer),
// read on the role's RPC for the preflight. Startup creates the missing ones; this never sends.
import { createSolanaRpc } from '@solana/kit';

import { DEVNET_GENESIS, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { uptoRecipientTokenAccounts } from '@gyblos/payments-upto';

import { readGenesis, type GenesisReader } from './seller-chain';

export interface PaymentAccountsQuery {
  rpcUrl: string;
  mint: string;
  owners: readonly string[];
}

// How many of the owners have no token account for the mint, and how many have one that could never
// receive a payout (frozen, say); throws when the RPC cannot say.
export async function paymentAccountsStatus(query: PaymentAccountsQuery) {
  const { missing, unusable } = await uptoRecipientTokenAccounts(
    createSolanaRpc(query.rpcUrl),
    { ...query, tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram },
  );
  return { missing: missing.length, unusable: unusable.length };
}

export interface PaymentAccountsProbes {
  genesis?: GenesisReader;
  paymentAccounts?: typeof paymentAccountsStatus;
}

// What startup would find: another chain (refused, so its accounts are not read), an account that
// could never receive its share (refused), missing ones (created), or an RPC that did not answer.
export async function paymentAccountsVerdict(
  query: PaymentAccountsQuery,
  probes: PaymentAccountsProbes,
): Promise<'ready' | 'missing' | 'unusable' | 'unchecked' | 'other-network'> {
  const served = await (probes.genesis ?? readGenesis)(query.rpcUrl).catch(
    () => undefined,
  );
  if (served === undefined) return 'unchecked';
  if (served !== DEVNET_GENESIS) return 'other-network';
  try {
    const { missing, unusable } = await (
      probes.paymentAccounts ?? paymentAccountsStatus
    )(query);
    if (unusable > 0) return 'unusable';
    return missing > 0 ? 'missing' : 'ready';
  } catch {
    return 'unchecked';
  }
}
