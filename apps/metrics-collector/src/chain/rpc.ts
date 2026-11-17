// Owns the Solana JSON-RPC reads the chain index makes: program signatures (finalized, newest first),
// transactions in batched requests, and accounts with their owner. The URL must be https (http only on
// loopback) with no credentials, query or fragment; redirects are refused, answers are size-capped and
// matched by id. Answers are returned as unknown, checked by the callers. Any HTTP or RPC error, or a
// transaction the RPC cannot return, throws: the run stops and nothing past it is marked as read.
import { CHANNEL_PROGRAM } from '@gyblos/config/network';

import { CHAIN_INDEX, LOOPBACK_HOSTS } from '../constants';
import { ChainShapeError, list, nullable, record, text } from './json';

const FINALIZED = 'finalized';
const JSON_RPC = '2.0';
const HTTPS = 'https:';
const HTTP = 'http:';

export class ChainRpcError extends Error {
  constructor(readonly reason: string) {
    super(`solana rpc: ${reason}`);
    this.name = 'ChainRpcError';
  }
}

// The configured RPC URL, or undefined when it is not one the index may call.
export function chainRpcUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const allowed =
    url.protocol === HTTPS ||
    (url.protocol === HTTP && LOOPBACK_HOSTS.has(url.hostname));
  return allowed && !url.username && !url.password && !url.search && !url.hash
    ? url.toString()
    : undefined;
}

export interface ChainAccount {
  owner: string;
  data: string;
}
export interface ChainRpc {
  // Signatures of the program, newest first: newer than `until`, older than `before`, one page.
  signatures(options: {
    until?: string;
    before?: string;
  }): Promise<{ signature: string }[]>;
  // jsonParsed transactions, in the order asked.
  transactions(signatures: string[]): Promise<unknown[]>;
  // Each address's owner and base64 data, in the order asked; null when the account does not exist.
  accounts(addresses: string[]): Promise<(ChainAccount | null)[]>;
}

async function readCapped(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > CHAIN_INDEX.maxResponseBytes)
    throw new ChainRpcError('answer too large');
  const body = await response.text();
  if (body.length > CHAIN_INDEX.maxResponseBytes)
    throw new ChainRpcError('answer too large');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ChainRpcError('answer not json');
  }
}

// Sends JSON-RPC calls in one batched request and returns their results in the order asked.
function batchPoster(url: string, fetcher: typeof fetch) {
  let nextId = 0;
  return async (calls: { method: string; params: unknown[] }[]) => {
    const ids = calls.map(() => ++nextId);
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        calls.map((call, index) => ({
          jsonrpc: JSON_RPC,
          id: ids[index],
          ...call,
        })),
      ),
      redirect: 'error',
      signal: AbortSignal.timeout(CHAIN_INDEX.requestTimeoutMs),
    });
    if (!response.ok) throw new ChainRpcError(`HTTP ${response.status}`);
    const byId = new Map<number, unknown>();
    for (const answer of list(await readCapped(response), 'rpc batch')) {
      const reply = record(answer, 'rpc reply');
      if (reply.jsonrpc !== JSON_RPC || typeof reply.id !== 'number')
        throw new ChainShapeError('rpc reply');
      if (reply.error)
        throw new ChainRpcError(
          `error ${String(record(reply.error, 'rpc error').code)}`,
        );
      byId.set(reply.id, reply.result);
    }
    return ids.map((id) => {
      if (!byId.has(id)) throw new ChainRpcError('missing reply');
      return byId.get(id);
    });
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
      const results = await post(
        signatures.map((signature) => ({
          method: 'getTransaction',
          params: [
            signature,
            {
              encoding: 'jsonParsed',
              maxSupportedTransactionVersion: CHAIN_INDEX.maxTransactionVersion,
              commitment: FINALIZED,
            },
          ],
        })),
      );
      // A listed, finalized transaction the RPC cannot return now (a lagging backend): retry later.
      for (const result of results)
        if (result === null || result === undefined)
          throw new ChainRpcError('transaction unavailable');
      return results;
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
          nullable(entry, (present) => {
            const account = record(present, 'account');
            return {
              owner: text(account.owner, 'account.owner'),
              data: text(list(account.data, 'account.data')[0], 'data'),
            };
          }),
      );
    },
  };
}
