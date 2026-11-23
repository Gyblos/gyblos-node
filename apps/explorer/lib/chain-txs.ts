import {
  chainTxsUrl,
  parseChainTxs,
  type ChainTxPage,
} from './chain-txs-shape';
import { COLLECTOR_URL } from './config';
import { fetchJson } from './fetch-json';

export async function getChainTxs(
  before: string | null,
  recipient: string | null = null,
): Promise<ChainTxPage> {
  try {
    return {
      ...parseChainTxs(
        await fetchJson(
          chainTxsUrl(COLLECTOR_URL, before, recipient),
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
