// Projects observed native transaction keys/SPL balances into the existing RPC reader contracts.
// Values come from VM account bytes, never from a scenario's expected payout or status.
import assert from 'node:assert/strict';

import {
  getTokenDecoder,
  getTokenSize,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  type Address,
  type Signature,
  type Transaction,
} from '@solana/kit';
import { FailedTransactionMetadata, type LiteSVM } from 'litesvm';

export function nativeHistory(vm: Pick<LiteSVM, 'getAccount' | 'getClock'>) {
  const balances = (keys: readonly Address[]) =>
    keys.flatMap((key, accountIndex) => {
      const found = vm.getAccount(key);
      if (
        !found.exists ||
        found.programAddress !== TOKEN_PROGRAM_ADDRESS ||
        found.data.length !== getTokenSize()
      )
        return [];
      const token = getTokenDecoder().decode(found.data);
      return [
        {
          accountIndex,
          mint: String(token.mint),
          owner: String(token.owner),
          uiTokenAmount: { amount: String(token.amount) },
        },
      ];
    });
  const before = (transaction: Transaction) => {
    const message = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
    if ('addressTableLookups' in message)
      assert.equal(message.addressTableLookups?.length ?? 0, 0);
    return {
      signature: getSignatureFromTransaction(transaction),
      keys: message.staticAccounts,
      pre: balances(message.staticAccounts),
      slot: vm.getClock().slot,
    };
  };
  type Observed = ReturnType<typeof before> & {
    post: ReturnType<typeof balances>;
    err: string | null;
  };
  const records = new Map<Signature, Observed>();
  return {
    oldestSlot: vm.getClock().slot,
    before,
    after(
      observed: ReturnType<typeof before>,
      result: ReturnType<LiteSVM['sendTransaction']>,
    ) {
      if (records.has(observed.signature)) return;
      records.set(observed.signature, {
        ...observed,
        post: balances(observed.keys),
        err:
          result instanceof FailedTransactionMetadata
            ? result.err().toString()
            : null,
      });
    },
    status(signature: Signature) {
      const record = records.get(signature);
      return record ? { err: record.err, slot: record.slot } : null;
    },
    signatures(account: string, beforeSignature?: string, limit = 1000) {
      const found = [...records.values()]
        .reverse()
        .filter((record) => record.keys.some((key) => key === account));
      const start = beforeSignature
        ? found.findIndex((record) => record.signature === beforeSignature) + 1
        : 0;
      return found
        .slice(start, start + limit)
        .map((record) => ({ signature: record.signature, err: record.err }));
    },
    transaction(signature: Signature) {
      const record = records.get(signature);
      return record
        ? {
            meta: {
              err: record.err,
              preTokenBalances: record.pre,
              postTokenBalances: record.post,
            },
            transaction: { message: { accountKeys: record.keys } },
          }
        : null;
    },
  };
}
