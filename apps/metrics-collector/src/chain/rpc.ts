// Owns the Solana JSON-RPC reads the chain index makes, one call per request (a batch is billed and
// rate-limited per call anyway): signatures of an address (finalized, newest first, with each one's
// error, block time and memo), one transaction, and accounts with their owner. The URL must be https
// (http only on loopback) with no credentials, query or fragment; redirects are refused, answers are
// size-capped and matched by id. Any HTTP or RPC error, or a transaction the RPC cannot return, throws:
// the run stops and nothing past it is marked as read. A rate limit throws an error marked as such,
// which lets the run move to its fallback endpoint.
import { CHAIN_INDEX, LOOPBACK_HOSTS } from '../constants';
import { ChainShapeError, list, nullable, num, record, text } from './json';

const FINALIZED = 'finalized';
const JSON_RPC = '2.0';
const HTTPS = 'https:';
const HTTP = 'http:';
const TOO_MANY_REQUESTS = 429;

export class ChainRpcError extends Error {
  constructor(
    readonly reason: string,
    // The endpoint refused the call for its rate limit (HTTP 429 or the RPC's own limit code).
    readonly rateLimited = false,
  ) {
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
// One entry of an address's signature list: enough to count and filter without reading the
// transaction. The memo is the RPC's rendering ("[length] text", several joined by "; ").
export interface ChainSignature {
  signature: string;
  slot: number;
  failed: boolean;
  blockTimeMs: number | null;
  memo: string | null;
}
export interface ChainRpc {
  // Signatures of `address`, newest first: newer than `until`, older than `before`, one page.
  signatures(
    address: string,
    options: { until?: string; before?: string },
  ): Promise<ChainSignature[]>;
  // One jsonParsed transaction.
  transaction(signature: string): Promise<unknown>;
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

// Sends one JSON-RPC call and returns its result.
function caller(url: string, fetcher: typeof fetch) {
  let nextId = 0;
  return async (method: string, params: unknown[]) => {
    const id = ++nextId;
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: JSON_RPC, id, method, params }),
      redirect: 'error',
      signal: AbortSignal.timeout(CHAIN_INDEX.requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ChainRpcError(
        `HTTP ${response.status}`,
        response.status === TOO_MANY_REQUESTS,
      );
    }
    const reply = record(await readCapped(response), 'rpc reply');
    if (reply.jsonrpc !== JSON_RPC || reply.id !== id)
      throw new ChainShapeError('rpc reply');
    if (reply.error) {
      const code = Number(record(reply.error, 'rpc error').code);
      throw new ChainRpcError(
        `error ${code}`,
        (CHAIN_INDEX.rateLimitCodes as readonly number[]).includes(code),
      );
    }
    return reply.result;
  };
}

function signatureOf(entry: unknown): ChainSignature {
  const value = record(entry, 'signature');
  const blockTime = nullable(value.blockTime, (present) =>
    num(present, 'signature.blockTime'),
  );
  return {
    signature: text(value.signature, 'signature'),
    slot: num(value.slot, 'signature.slot'),
    failed: value.err !== null && value.err !== undefined,
    blockTimeMs:
      blockTime === null ? null : blockTime * CHAIN_INDEX.msPerSecond,
    memo: nullable(value.memo, (present) => text(present, 'signature.memo')),
  };
}

export function createChainRpc(
  url: string,
  fetcher: typeof fetch = fetch,
): ChainRpc {
  const call = caller(url, fetcher);
  return {
    async signatures(address, { until, before }) {
      const result = await call('getSignaturesForAddress', [
        address,
        {
          limit: CHAIN_INDEX.signaturesPerPage,
          commitment: FINALIZED,
          ...(until ? { until } : {}),
          ...(before ? { before } : {}),
        },
      ]);
      return list(result, 'signatures').map(signatureOf);
    },
    async transaction(signature) {
      const result = await call('getTransaction', [
        signature,
        {
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: CHAIN_INDEX.maxTransactionVersion,
          commitment: FINALIZED,
        },
      ]);
      // A listed, finalized transaction the RPC cannot return now (a lagging backend): retry later.
      if (result === null || result === undefined)
        throw new ChainRpcError('transaction unavailable');
      return result;
    },
    async accounts(addresses) {
      if (!addresses.length) return [];
      const result = await call('getMultipleAccounts', [
        addresses,
        { encoding: 'base64', commitment: FINALIZED },
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
