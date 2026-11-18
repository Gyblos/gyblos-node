// Synthetic Solana RPC for chain index tests: a chain history (newest first) in which each transaction
// names the program and its channels, served the way getSignaturesForAddress pages an address's list
// (with error, block time and memo), jsonParsed transactions by signature, and accounts by address.
import { decodeTransaction } from '@gyblos/metrics-collector/chain/decode';
import {
  chainEndpoints,
  type ChainEndpoints,
} from '@gyblos/metrics-collector/chain/endpoints';
import {
  ChainRpcError,
  type ChainAccount,
  type ChainRpc,
  type ChainSignature,
} from '@gyblos/metrics-collector/chain/rpc';
import { CHAIN_INDEX } from '@gyblos/metrics-collector/constants';

export const PROGRAM = 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';
// Inside the history the index reads (after CHAIN_INDEX.historyFloorMs).
export const BLOCK_TIME_S = 1_794_800_000;

export interface ChainEntry {
  signature: string;
  tx: unknown;
  listed: ChainSignature;
  // Addresses whose signature list holds this transaction.
  addresses: string[];
}

// A minimal jsonParsed transaction with the given top-level instructions.
export function plainTx(
  signature: string,
  instructions: unknown[],
  meta: Record<string, unknown> = {},
) {
  return {
    slot: 1,
    blockTime: BLOCK_TIME_S,
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], ...meta },
    transaction: { signatures: [signature], message: { instructions } },
  };
}

// A history entry for `tx` (a plain one by default) under `signature`. Its list entry and addresses
// come from the transaction itself (the program, plus each channel its instructions name) unless given.
export function withSignature(
  signature: string,
  tx?: unknown,
  overrides: {
    blockTimeMs?: number | null;
    slot?: number;
    failed?: boolean;
    addresses?: string[];
  } = {},
): ChainEntry {
  const copy = structuredClone(tx ?? plainTx(signature, [])) as {
    transaction: { signatures: string[] };
    meta: Record<string, unknown>;
  };
  copy.transaction.signatures = [signature];
  if (overrides.slot !== undefined)
    (copy as unknown as { slot: number }).slot = overrides.slot;
  if (overrides.failed) copy.meta.err = { InstructionError: [0, 'Custom'] };
  const decoded = decodeTransaction(copy);
  const memos = decoded.failed
    ? []
    : decoded.memos.map((memo) => `[${memo.length}] ${memo}`);
  return {
    signature,
    tx: copy,
    listed: {
      signature,
      slot: decoded.slot,
      failed: decoded.failed,
      blockTimeMs:
        overrides.blockTimeMs === undefined
          ? decoded.blockTimeMs
          : overrides.blockTimeMs,
      memo: memos.length ? memos.join('; ') : null,
    },
    addresses: overrides.addresses ?? [
      PROGRAM,
      ...new Set(decoded.instructions.map((entry) => entry.channel)),
    ],
  };
}

export function fakeChainRpc(
  history: ChainEntry[],
  accounts: Record<string, ChainAccount | null> = {},
) {
  const calls = { signatures: 0, transaction: 0, accounts: 0 };
  const rpc: ChainRpc = {
    signatures(address, { until, before }) {
      calls.signatures += 1;
      const list = history.filter((entry) => entry.addresses.includes(address));
      const position = (signature: string) =>
        list.findIndex((entry) => entry.signature === signature);
      const start = before ? position(before) + 1 : 0;
      const end = until ? position(until) : list.length;
      return Promise.resolve(
        list
          .slice(start, end === -1 ? list.length : end)
          .slice(0, CHAIN_INDEX.signaturesPerPage)
          .map((entry) => entry.listed),
      );
    },
    transaction(signature) {
      calls.transaction += 1;
      const found = history.find((entry) => entry.signature === signature);
      return found
        ? Promise.resolve(found.tx)
        : Promise.reject(new ChainRpcError('transaction unavailable'));
    },
    accounts(addresses) {
      calls.accounts += 1;
      return Promise.resolve(
        addresses.map((address) => accounts[address] ?? null),
      );
    },
  };
  return { rpc, calls };
}

// An endpoint that rate-limits every call after its first `allowed` ones.
export function limitedAfter(rpc: ChainRpc, allowed: number): ChainRpc {
  let used = 0;
  const gate = <T>(work: () => Promise<T>) =>
    ++used > allowed
      ? Promise.reject(new ChainRpcError('HTTP 429', true))
      : work();
  return {
    signatures: (address, range) => gate(() => rpc.signatures(address, range)),
    transaction: (signature) => gate(() => rpc.transaction(signature)),
    accounts: (addresses) => gate(() => rpc.accounts(addresses)),
  };
}

// The run's endpoints with no pause between calls: the public one, and an optional paid fallback.
export function endpoints(
  rpc: ChainRpc,
  budget = 1000,
  fallback?: { rpc: ChainRpc; budget: number },
): ChainEndpoints {
  return chainEndpoints(
    { rpc, limits: { budget, minIntervalMs: 0 } },
    fallback && {
      rpc: fallback.rpc,
      limits: { budget: fallback.budget, minIntervalMs: 0 },
    },
    { wait: () => Promise.resolve() },
  );
}
