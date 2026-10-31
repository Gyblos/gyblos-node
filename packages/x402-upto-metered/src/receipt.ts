// The buyer's view of a claim transaction, from its own token balances: what payTo, the fee treasury
// and the payer received, and the charge as the ceiling minus the refund once the channel's escrow is
// empty. A missing, failed, foreign or unfinished transaction shows no settlement. No Gyblos imports.
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

export function createUptoReceiptReader(
  rpc: UptoTransactionRpc,
  commitment: UptoCommitment = UPTO_COMMITMENT,
) {
  return {
    async settlement(
      query: UptoReceiptQuery,
    ): Promise<UptoSettlementShown | undefined> {
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
      if (!found || !meta || meta.err !== null) return undefined;
      const keys = [
        ...found.transaction.message.accountKeys,
        ...(meta.loadedAddresses?.writable ?? []),
        ...(meta.loadedAddresses?.readonly ?? []),
      ].map(String);
      if (!keys.includes(query.channelId)) return undefined;
      const change = (owner: string) =>
        held(meta.postTokenBalances, owner, query.mint) -
        held(meta.preTokenBalances, owner, query.mint);
      const escrowBefore = held(
        meta.preTokenBalances,
        query.channelId,
        query.mint,
      );
      const escrowAfter = held(
        meta.postTokenBalances,
        query.channelId,
        query.mint,
      );
      const seller = change(query.payTo);
      const fee = change(query.treasury);
      const refund = change(query.payer);
      const ceiling = BigInt(query.maxAtomic);
      // A final claim releases the whole deposit, empties the escrow and only ever pays out.
      if (
        escrowBefore < ceiling ||
        escrowAfter !== 0n ||
        seller < 0n ||
        fee < 0n ||
        refund < 0n ||
        refund > ceiling
      )
        return undefined;
      return {
        channelId: query.channelId,
        chargedAtomic: String(ceiling - refund),
        refundedAtomic: String(refund),
        sellerAtomic: String(seller),
        feeAtomic: String(fee),
      };
    },
  };
}
