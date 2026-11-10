// Validates replies from the owned parent VM and exposes the unchanged SDK/payment RPC ports.
// Only public data and unsigned/signed transaction bytes cross private IPC; keys stay in the parent.
import assert from 'node:assert/strict';

import {
  address,
  assertIsSignatureBytes,
  blockhash,
  getBase64EncodedWireTransaction,
  signature,
  type TransactionPartialSigner,
} from '@solana/kit';
import {
  UPTO_FINAL_COMMITMENT,
  type UptoHintRpc,
  type UptoSignaturesRpc,
  type UptoTransactionRpc,
} from 'x402-upto-metered';

import type { UptoWithdrawRpc } from '@gyblos/payments-upto';

import { CRASH_CALLS, type CrashCall } from './channel-crash-constants';

export type CrashCallPort = (
  method: CrashCall,
  args: readonly unknown[],
) => Promise<unknown>;
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const crashObject = (value: unknown): Record<string, unknown> => {
  assert.ok(isObject(value));
  return value;
};
const string = (value: unknown) => {
  assert.equal(typeof value, 'string');
  assert.ok(typeof value === 'string');
  return value;
};
const integer = (value: unknown) => {
  assert.ok(typeof value === 'bigint' && value >= 0n);
  return value;
};

function tokenBalances(value: unknown) {
  assert.ok(Array.isArray(value));
  return value.map((item) => {
    const row = crashObject(item);
    const amount = crashObject(row.uiTokenAmount);
    const text = string(amount.amount);
    assert.match(text, /^(0|[1-9][0-9]{0,19})$/);
    return {
      mint: address(string(row.mint)),
      owner: address(string(row.owner)),
      uiTokenAmount: { amount: text },
    };
  });
}

export function crashRpc(call: CrashCallPort) {
  return {
    getGenesisHash: () => ({
      send: async () => string(await call(CRASH_CALLS.GENESIS, [])),
    }),
    getEpochInfo: () => ({
      send: async () => {
        const value = crashObject(await call(CRASH_CALLS.EPOCH, []));
        return {
          absoluteSlot: integer(value.absoluteSlot),
          blockHeight: integer(value.blockHeight),
        };
      },
    }),
    getSlot: () => ({
      send: async () => integer(await call(CRASH_CALLS.SLOT, [])),
    }),
    getBlockTime: () => ({
      send: async () => integer(await call(CRASH_CALLS.TIME, [])),
    }),
    getLatestBlockhash: () => ({
      send: async () => {
        const value = crashObject(await call(CRASH_CALLS.BLOCKHASH, []));
        return {
          value: {
            blockhash: blockhash(string(value.recentBlockhash)),
            lastValidBlockHeight: BigInt(string(value.lastValidBlockHeight)),
          },
        };
      },
    }),
    getAccountInfo: (account, config) => ({
      send: async () => {
        const result = crashObject(
          await call(CRASH_CALLS.ACCOUNT, [account, config]),
        );
        const context = { slot: integer(crashObject(result.context).slot) };
        if (result.value === null) return { value: null, context };
        const value = crashObject(result.value);
        assert.ok(
          Array.isArray(value.data) &&
            value.data.length === 2 &&
            value.data[1] === 'base64',
        );
        const data: [string, 'base64'] = [string(value.data[0]), 'base64'];
        return {
          value: { owner: address(string(value.owner)), data },
          context,
        };
      },
    }),
    sendTransaction: (wire) => ({
      send: async () => signature(string(await call(CRASH_CALLS.SEND, [wire]))),
    }),
    getSignatureStatuses: (signatures) => ({
      send: async () => {
        const result = crashObject(
          await call(CRASH_CALLS.STATUSES, [signatures]),
        );
        assert.ok(Array.isArray(result.value));
        return {
          context: { slot: integer(crashObject(result.context).slot) },
          value: result.value.map((item) => {
            if (item === null) return null;
            const row = crashObject(item);
            assert.equal(row.confirmationStatus, UPTO_FINAL_COMMITMENT);
            assert.ok(row.err === null || typeof row.err === 'string');
            return {
              err: row.err,
              confirmationStatus: UPTO_FINAL_COMMITMENT,
              slot: integer(row.slot),
            };
          }),
        };
      },
    }),
    getSignaturesForAddress: (account, config) => ({
      send: async () => {
        const rows = await call(CRASH_CALLS.HISTORY, [account, config]);
        assert.ok(Array.isArray(rows));
        return rows.map((value) => {
          const row = crashObject(value);
          assert.ok(Object.hasOwn(row, 'err'));
          return { signature: signature(string(row.signature)), err: row.err };
        });
      },
    }),
    getTransaction: (found) => ({
      send: async () => {
        const raw = await call(CRASH_CALLS.TRANSACTION, [found]);
        if (raw === null) return null;
        const value = crashObject(raw);
        const meta = crashObject(value.meta);
        const message = crashObject(crashObject(value.transaction).message);
        assert.ok(
          Array.isArray(message.accountKeys) && Object.hasOwn(meta, 'err'),
        );
        return {
          meta: {
            err: meta.err,
            preTokenBalances: tokenBalances(meta.preTokenBalances),
            postTokenBalances: tokenBalances(meta.postTokenBalances),
          },
          transaction: {
            message: {
              accountKeys: message.accountKeys.map((key) =>
                address(string(key)),
              ),
            },
          },
        };
      },
    }),
    minimumLedgerSlot: () => ({
      send: async () => integer(await call(CRASH_CALLS.OLDEST, [])),
    }),
    getFirstAvailableBlock: () => ({
      send: async () => integer(await call(CRASH_CALLS.OLDEST, [])),
    }),
  } satisfies UptoWithdrawRpc &
    UptoSignaturesRpc &
    UptoTransactionRpc &
    UptoHintRpc;
}

export function crashSigner(
  payer: string,
  call: CrashCallPort,
): TransactionPartialSigner {
  const owner = address(payer);
  return {
    address: owner,
    async signTransactions(transactions) {
      const reply = await call(CRASH_CALLS.SIGN, [
        transactions.map((transaction) =>
          getBase64EncodedWireTransaction(transaction),
        ),
      ]);
      assert.ok(Array.isArray(reply) && reply.length === transactions.length);
      return reply.map((raw) => {
        assert.ok(raw instanceof Uint8Array);
        assertIsSignatureBytes(raw);
        return { [owner]: raw };
      });
    },
  };
}
