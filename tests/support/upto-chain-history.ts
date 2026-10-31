// A finalized chain double for buyer reconciliation: per-address history (newest first, paged like the
// RPC), synthetic token-balance transactions, the finalized tip, the oldest slot and block held and
// which accounts exist. Every call is recorded with its commitment and context slot; no network.
import {
  address,
  signature as asSignature,
  getBase58Decoder,
} from '@solana/kit';
import type { UptoSignaturesRpc, UptoTransactionRpc } from 'x402-upto-metered';

export const signatureOf = (index: number) => {
  const bytes = new Uint8Array(64);
  new DataView(bytes.buffer).setUint32(0, index + 1);
  return getBase58Decoder().decode(bytes);
};

export interface Flow {
  owner: string;
  before: bigint;
  after: bigint;
}
export interface HistoryEntry {
  signature: string;
  failed?: boolean;
  // Token balances of the mint this transaction changed; absent for one that moved none.
  flows?: Flow[];
}

export interface ChainState {
  mint: string;
  // Oldest first, per address.
  history: Map<string, HistoryEntry[]>;
  blockHeight: bigint;
  oldestSlot: bigint;
  // The oldest block still served; defaults to oldestSlot.
  firstBlock?: bigint;
  accounts: Set<string>;
  failing?: boolean;
}

export function chainDouble(state: ChainState) {
  const commitments: string[] = [];
  // Each read in order, with the context slot it demanded.
  const reads: { call: string; minContextSlot?: bigint }[] = [];
  const TIP = 1_000n;
  const unavailable = () => {
    if (state.failing)
      throw new Error('rpc down at https://rpc.example/?key=s');
  };
  const byId = new Map(
    [...state.history.entries()].flatMap(([account, entries]) =>
      entries.map((entry) => [entry.signature, { account, entry }] as const),
    ),
  );
  const balances = (flows: Flow[], when: 'before' | 'after') =>
    flows.map((flow, index) => ({
      accountIndex: index,
      mint: state.mint,
      owner: flow.owner,
      uiTokenAmount: { amount: String(flow[when]) },
    }));
  const rpc: UptoSignaturesRpc & UptoTransactionRpc = {
    getSignaturesForAddress: (account, config) => ({
      send: async () => {
        commitments.push(config.commitment);
        reads.push({
          call: 'signatures',
          minContextSlot: config.minContextSlot,
        });
        unavailable();
        const newest = [
          ...(state.history.get(String(account)) ?? []),
        ].reverse();
        const start = config.before
          ? newest.findIndex((entry) => entry.signature === config.before) + 1
          : 0;
        return newest.slice(start, start + config.limit).map((entry) => ({
          signature: asSignature(entry.signature),
          err: entry.failed ? { InstructionError: [0, 'Custom'] } : null,
        }));
      },
    }),
    getTransaction: (found, config) => ({
      send: async () => {
        commitments.push(config.commitment);
        unavailable();
        const known = byId.get(String(found));
        if (!known) return null;
        const flows = known.entry.flows ?? [];
        return {
          meta: {
            err: known.entry.failed
              ? { InstructionError: [0, 'Custom'] }
              : null,
            preTokenBalances: balances(flows, 'before'),
            postTokenBalances: balances(flows, 'after'),
          },
          transaction: { message: { accountKeys: [known.account] } },
        };
      },
    }),
    getEpochInfo: (config) => ({
      send: async () => {
        commitments.push(config.commitment);
        reads.push({ call: 'tip' });
        unavailable();
        return { absoluteSlot: TIP, blockHeight: state.blockHeight };
      },
    }),
    getFirstAvailableBlock: () => ({
      send: async () => {
        unavailable();
        return state.firstBlock ?? state.oldestSlot;
      },
    }),
    minimumLedgerSlot: () => ({
      send: async () => {
        unavailable();
        return state.oldestSlot;
      },
    }),
    getAccountInfo: (account, config) => ({
      send: async () => {
        commitments.push(config.commitment);
        reads.push({ call: 'account', minContextSlot: config.minContextSlot });
        unavailable();
        return {
          value: state.accounts.has(String(account))
            ? { owner: address(String(account)) }
            : null,
        };
      },
    }),
  };
  return { rpc, commitments, reads, tip: TIP };
}
