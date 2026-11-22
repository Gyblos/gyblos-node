import { parseChainTxs, type ChainTxPage } from './chain-txs-shape';
import { COLLECTOR_URL } from './config';
import { CHAIN_TXS } from './constants';
import { fetchJson } from './fetch-json';

export async function getChainTxs(before: string | null): Promise<ChainTxPage> {
  const params = new URLSearchParams({ limit: String(CHAIN_TXS.pageSize) });
  if (before) params.set(CHAIN_TXS.param, before);
  try {
    return {
      ...parseChainTxs(
        await fetchJson(
          `${COLLECTOR_URL}/stats/chain/txs?${params.toString()}`,
          'collector chain transactions',
        ),
      ),
      error: null,
    };
  } catch (error) {
    return {
      programId: '',
      transactions: [],
      next: null,
      error:
        error instanceof Error
          ? error.message
          : 'chain transactions unavailable',
    };
  }
}
