import {
  chainTxsQuery,
  parseChainTxs,
  type ChainTxPage,
} from './chain-txs-shape';
import { COLLECTOR_URL } from './config';
import { fetchJson } from './fetch-json';

export async function getChainTxs(before: string | null): Promise<ChainTxPage> {
  try {
    return {
      ...parseChainTxs(
        await fetchJson(
          `${COLLECTOR_URL}/stats/chain/txs?${chainTxsQuery(before)}`,
          'collector chain transactions',
        ),
      ),
      error: null,
    };
  } catch (error) {
    return {
      programId: '',
      treasury: '',
      transactions: [],
      next: null,
      error:
        error instanceof Error
          ? error.message
          : 'chain transactions unavailable',
    };
  }
}
