// Paid seller preflight: read the recipient token accounts and fee payer balance on the role's RPC.
// Startup creates the missing accounts; these probes never send transactions.
import { address } from '@solana/kit';

import { DEVNET_GENESIS, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { uptoRecipientTokenAccounts } from '@gyblos/payments-upto';
import { rateLimitedSolanaRpc } from '@gyblos/payments-upto/rpc-rate-limit';

import {
  DOCTOR_STATUS,
  FEE_PAYER_FUNDING,
  GENESIS_READ_MS,
  type DoctorStatus,
} from './constants';
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
    rateLimitedSolanaRpc(query.rpcUrl),
    { ...query, tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram },
  );
  return { missing: missing.length, unusable: unusable.length };
}

// The fee payer's devnet SOL, in lamports; throws when the RPC cannot say.
async function feePayerLamports(query: {
  rpcUrl: string;
  address: string;
}): Promise<bigint> {
  const { value } = await rateLimitedSolanaRpc(query.rpcUrl)
    .getBalance(address(query.address))
    .send({ abortSignal: AbortSignal.timeout(GENESIS_READ_MS) });
  return value;
}

export async function feePayerFundingStatus(
  query: { rpcUrl: string; address: string },
  accounts: Awaited<ReturnType<typeof paymentAccountsVerdict>>,
  probes: PaymentAccountsProbes,
): Promise<DoctorStatus | undefined> {
  if (accounts !== 'ready' && accounts !== 'missing') return undefined;
  const balance = await (probes.feePayerLamports ?? feePayerLamports)(
    query,
  ).catch(() => undefined);
  if (accounts === 'missing' && balance === 0n) return DOCTOR_STATUS.FAIL;
  if (balance !== undefined && balance < FEE_PAYER_FUNDING.minimumLamports)
    return DOCTOR_STATUS.WARN;
  return undefined;
}

export interface PaymentAccountsProbes {
  genesis?: GenesisReader;
  paymentAccounts?: typeof paymentAccountsStatus;
  feePayerLamports?: typeof feePayerLamports;
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
