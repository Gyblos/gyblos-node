// The token accounts a seller's paid claim pays into (payout, protocol fee treasury and fee payer),
// read on the role's RPC for the preflight. Startup creates the missing ones; this never sends.
import { createSolanaRpc } from '@solana/kit';

import { UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { uptoMissingTokenAccounts } from '@gyblos/payments-upto';

export interface PaymentAccountsQuery {
  rpcUrl: string;
  mint: string;
  owners: readonly string[];
}

// How many of the owners have no token account for the mint; throws when the RPC cannot say.
export const missingPaymentAccounts = async (query: PaymentAccountsQuery) =>
  (
    await uptoMissingTokenAccounts(createSolanaRpc(query.rpcUrl), {
      ...query,
      tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram,
    })
  ).length;
