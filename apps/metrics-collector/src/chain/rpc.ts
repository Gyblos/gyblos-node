// Owns the Solana JSON-RPC reads the chain index makes: program signatures (finalized, newest first),
// transactions in batched requests, and channel accounts. Answers are returned as unknown, checked by
// the callers; any HTTP or RPC error throws, and the run stops without moving its cursor.
import { CHANNEL_PROGRAM } from '@gyblos/config/network';

import { CHAIN_INDEX } from '../constants';
import { list, record, text } from './json';

const FINALIZED = 'finalized';
const JSON_RPC = '2.0';

export interface ChainRpc {
  // Signatures of the program, newest first; `until` stops before a known one, `before` pages back.
  signatures(options: {
    until?: string;
    before?: string;
  }): Promise<{ signature: string }[]>;
  // jsonParsed transactions, in the order asked; null when the RPC does not have one.
  transactions(signatures: string[]): Promise<unknown[]>;
  // Base64 account data for each address, in the order asked; null when the account does not exist.
  accounts(addresses: string[]): Promise<(string | null)[]>;
}

// Sends JSON-RPC calls in one batched request and returns their results in the order asked.
function batchPoster(url: string, fetcher: typeof fetch) {
  let id = 0;
  return async (calls: { method: string; params: unknown[] }[]) => {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        calls.map((call) => ({ jsonrpc: JSON_RPC, id: ++id, ...call })),
      ),
      signal: AbortSignal.timeout(CHAIN_INDEX.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`solana rpc: HTTP ${response.status}`);
    const answers = list((await response.json()) as unknown, 'rpc batch');
    // A batch answer may come in any order: match by id.
    const byId = new Map(
      answers.map((answer) => {
        const reply = record(answer, 'rpc reply');
        if (reply.error)
          throw new Error(
            `solana rpc: error ${String(record(reply.error, 'rpc error').code)}`,
          );
        return [reply.id, reply.result];
      }),
    );
    const first = id - calls.length + 1;
    return calls.map((_, index) => byId.get(first + index));
  };
}

export function createChainRpc(
  url: string,
  fetcher: typeof fetch = fetch,
): ChainRpc {
  const post = batchPoster(url, fetcher);
  return {
    async signatures({ until, before }) {
      const [result] = await post([
        {
          method: 'getSignaturesForAddress',
          params: [
            CHANNEL_PROGRAM,
            {
              limit: CHAIN_INDEX.signaturesPerPage,
              commitment: FINALIZED,
              ...(until ? { until } : {}),
              ...(before ? { before } : {}),
            },
          ],
        },
      ]);
      return list(result, 'signatures').map((entry) => ({
        signature: text(record(entry, 'signature').signature, 'signature'),
      }));
    },
    async transactions(signatures) {
      if (!signatures.length) return [];
      return (
        await post(
          signatures.map((signature) => ({
            method: 'getTransaction',
            params: [
              signature,
              {
                encoding: 'jsonParsed',
                maxSupportedTransactionVersion:
                  CHAIN_INDEX.maxTransactionVersion,
                commitment: FINALIZED,
              },
            ],
          })),
        )
      ).map((result) => result ?? null);
    },
    async accounts(addresses) {
      if (!addresses.length) return [];
      const [result] = await post([
        {
          method: 'getMultipleAccounts',
          params: [addresses, { encoding: 'base64', commitment: FINALIZED }],
        },
      ]);
      return list(record(result, 'accounts').value, 'accounts.value').map(
        (entry) =>
          entry === null
            ? null
            : text(
                list(record(entry, 'account').data, 'account.data')[0],
                'data',
              ),
      );
    },
  };
}
