// Synthetic Solana RPC for chain index tests: a program history (newest first) served the way
// getSignaturesForAddress pages it, jsonParsed transactions by signature, and accounts by address.
import type { ChainRpc } from '@gyblos/metrics-collector/chain/rpc';
import { CHAIN_INDEX } from '@gyblos/metrics-collector/constants';

export const PROGRAM = 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';

// A minimal jsonParsed transaction with the given top-level instructions.
export function plainTx(
  signature: string,
  instructions: unknown[],
  meta: Record<string, unknown> = {},
) {
  return {
    slot: 1,
    blockTime: 1_794_800_000,
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], ...meta },
    transaction: { signatures: [signature], message: { instructions } },
  };
}
// A history entry; the transaction's own signature is set to `signature`.
export function withSignature(signature: string, tx?: unknown) {
  const base = (tx ?? plainTx(signature, [])) as {
    transaction: { signatures: string[] };
  };
  const copy = structuredClone(base);
  copy.transaction.signatures = [signature];
  return { signature, tx: copy };
}

export function fakeChainRpc(
  history: { signature: string; tx: unknown }[],
  accounts: Record<string, { owner: string; data: string } | null> = {},
) {
  const position = (signature: string) =>
    history.findIndex((entry) => entry.signature === signature);
  const rpc: ChainRpc = {
    signatures({ until, before }) {
      const start = before ? position(before) + 1 : 0;
      const end = until ? position(until) : history.length;
      return Promise.resolve(
        history
          .slice(start, end === -1 ? history.length : end)
          .slice(0, CHAIN_INDEX.signaturesPerPage)
          .map(({ signature }) => ({ signature })),
      );
    },
    transactions: (signatures) =>
      Promise.resolve(
        signatures.map(
          (signature) =>
            history.find((entry) => entry.signature === signature)?.tx ?? null,
        ),
      ),
    accounts: (addresses) =>
      Promise.resolve(addresses.map((address) => accounts[address] ?? null)),
  };
  return { rpc };
}
