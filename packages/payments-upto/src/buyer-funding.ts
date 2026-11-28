// Reports spendable devnet USDC in the same associated token account used by channel deposits.
import { uptoTokenAccount } from 'x402-upto-metered';

import {
  COMMITMENT,
  DEVNET_GENESIS,
  DEVNET_USDC,
  TOKEN_PROGRAM_ADDRESS,
} from '@gyblos/config/network';
import { controlAtomic } from '@gyblos/protocol/control-validation';

import {
  createBuyerObservationRpc,
  type BuyerObservationFetch,
} from './buyer-observation-transport';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function tokenBalance(value: unknown, payer: string, mint: string) {
  if (value === null) return '0';
  if (
    !record(value) ||
    value.executable !== false ||
    value.owner !== TOKEN_PROGRAM_ADDRESS
  )
    return null;
  const data = value.data;
  if (
    !record(data) ||
    data.program !== 'spl-token' ||
    !record(data.parsed) ||
    data.parsed.type !== 'account'
  )
    return null;
  const info = data.parsed.info;
  if (
    !record(info) ||
    info.owner !== payer ||
    info.mint !== mint ||
    info.state !== 'initialized' ||
    !record(info.tokenAmount)
  )
    return null;
  return controlAtomic(info.tokenAmount.amount);
}
export async function buyerUsdcBalance(
  payer: string,
  rpcUrl: string,
  fetcher?: BuyerObservationFetch,
): Promise<string | null> {
  try {
    const rpc = createBuyerObservationRpc(rpcUrl, fetcher);
    if ((await rpc.getGenesisHash().send()) !== DEVNET_GENESIS) return null;
    return await paymentTokenBalance(rpc, payer, DEVNET_USDC);
  } catch {
    return null;
  }
}

export async function paymentTokenBalance(
  rpc: Pick<ReturnType<typeof createBuyerObservationRpc>, 'getAccountInfo'>,
  payer: string,
  mint: string,
  signal?: AbortSignal,
) {
  const account = await uptoTokenAccount(payer, mint, TOKEN_PROGRAM_ADDRESS);
  const result = await rpc
    .getAccountInfo(account, { commitment: COMMITMENT, encoding: 'jsonParsed' })
    .send({ abortSignal: signal });
  return tokenBalance(result.value, payer, mint);
}
