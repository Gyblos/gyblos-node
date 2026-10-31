// The buyer's view of a channel transaction, from its token balances: a deposit that funded the escrow
// to the ceiling, or a final claim that emptied it, with what payTo, the fee treasury and the payer
// received and the charge as the escrow's outflow minus the refund. No Gyblos imports.
import { signature as asSignature, type Signature } from '@solana/kit';

import {
  UPTO_COMMITMENT,
  UPTO_ERROR_CODES,
  type UptoCommitment,
} from './constants';
import { UptoError } from './errors';

interface TokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

type FoundTransaction = {
  meta: {
    err: unknown;
    preTokenBalances?: readonly TokenBalance[] | null;
    postTokenBalances?: readonly TokenBalance[] | null;
    loadedAddresses?: {
      writable: readonly string[];
      readonly: readonly string[];
    };
  } | null;
  transaction: { message: { accountKeys: readonly string[] } };
} | null;

// The slice of a @solana/kit RPC the reader uses.
export interface UptoTransactionRpc {
  getTransaction(
    signature: Signature,
    config: {
      commitment: UptoCommitment;
      encoding: 'json';
      maxSupportedTransactionVersion: 0;
    },
  ): { send(): Promise<FoundTransaction> };
}

export interface UptoReceiptQuery {
  transaction: string;
  channelId: string;
  mint: string;
  maxAtomic: string;
  payer: string;
  payTo: string;
  treasury: string;
}

export interface UptoSettlementShown {
  channelId: string;
  chargedAtomic: string;
  refundedAtomic: string;
  sellerAtomic: string;
  feeAtomic: string;
}

// An owner's total balance of the mint, before or after; a missing account holds nothing.
function held(
  balances: readonly TokenBalance[] | null | undefined,
  owner: string,
  mint: string,
): bigint {
  return (balances ?? [])
    .filter((entry) => entry.owner === owner && entry.mint === mint)
    .reduce((total, entry) => total + BigInt(entry.uiTokenAmount.amount), 0n);
}

// What one transaction did to the channel: a final claim's settlement, and whether it funded the escrow.
export interface UptoChannelTransfer {
  settled: UptoSettlementShown | undefined;
  deposited: boolean;
}

export function createUptoReceiptReader(
  rpc: UptoTransactionRpc,
  commitment: UptoCommitment = UPTO_COMMITMENT,
) {
  const transfer = async (
    query: UptoReceiptQuery,
  ): Promise<UptoChannelTransfer> => {
    const none = { settled: undefined, deposited: false };
    let found: FoundTransaction;
    try {
      found = await rpc
        .getTransaction(asSignature(query.transaction), {
          commitment,
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
        })
        .send();
    } catch {
      throw new UptoError(UPTO_ERROR_CODES.UNAVAILABLE);
    }
    const meta = found?.meta;
    if (!found || !meta || meta.err !== null) return none;
    const keys = [
      ...found.transaction.message.accountKeys,
      ...(meta.loadedAddresses?.writable ?? []),
      ...(meta.loadedAddresses?.readonly ?? []),
    ].map(String);
    if (!keys.includes(query.channelId)) return none;
    const change = (owner: string) =>
      held(meta.postTokenBalances, owner, query.mint) -
      held(meta.preTokenBalances, owner, query.mint);
    const before = held(meta.preTokenBalances, query.channelId, query.mint);
    const after = held(meta.postTokenBalances, query.channelId, query.mint);
    const ceiling = BigInt(query.maxAtomic);
    const deposited = before < after && after >= ceiling;
    const seller = change(query.payTo);
    const fee = change(query.treasury);
    const refund = change(query.payer);
    // A final claim empties an escrow funded to at least the ceiling and only ever pays out. A top-up
    // makes the outflow larger than the ceiling; a refund the program redirected away from the payer
    // shows as a larger charge, never a smaller one.
    const outflow = before - after;
    if (
      before < ceiling ||
      after !== 0n ||
      seller < 0n ||
      fee < 0n ||
      refund < 0n ||
      refund > outflow
    )
      return { settled: undefined, deposited };
    return {
      deposited,
      settled: {
        channelId: query.channelId,
        chargedAtomic: String(outflow - refund),
        refundedAtomic: String(refund),
        sellerAtomic: String(seller),
        feeAtomic: String(fee),
      },
    };
  };
  return {
    transfer,
    async settlement(
      query: UptoReceiptQuery,
    ): Promise<UptoSettlementShown | undefined> {
      return (await transfer(query)).settled;
    },
  };
}
