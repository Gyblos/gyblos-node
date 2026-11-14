// Keeps real native batch finance and synthetic keys in the parent while a buyer process is killed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  address,
  getTransactionDecoder,
  signature,
  signBytes,
} from '@solana/kit';

import { batchNativeFinancial } from './batch-native';
import type { BatchCrashInput } from './batch-recovery-child';
import {
  CRASH_ACTIONS,
  CRASH_CALLS,
  CRASH_CUTS,
  type CrashCall,
  type CrashCut,
} from './channel-crash-constants';
import { crashChild } from './channel-crash-process';
import { crashObject } from './channel-crash-rpc';

const text = (value: unknown) => {
  assert.ok(typeof value === 'string');
  return value;
};

export async function batchRecoveryCrash() {
  let now = 1_800_000_000_000;
  const financial = await batchNativeFinancial(() => now, {
    buyerNodeId: '12'.repeat(32),
    sellerNodeId: '34'.repeat(32),
  });
  await financial.buyer.dispose();
  const vm = financial.vm;
  let transactionSigns = 0;
  let messageSigns = 0;
  const transactionMessages = new Set<string>();
  const voucherMessages = new Set<string>();
  async function signing(
    args: readonly unknown[],
    cut: CrashCut | undefined,
    pause: () => Promise<void>,
  ) {
    assert.ok(Array.isArray(args[0]));
    const message = args[1] === true;
    if (
      (message && cut === CRASH_CUTS.OPEN_SIGNED) ||
      (!message && cut === CRASH_CUTS.OPEN_BEFORE_CHECKPOINT)
    )
      await pause();
    return Promise.all(
      args[0].map(async (raw) => {
        let bytes: Uint8Array;
        if (message) {
          assert.ok(raw instanceof Uint8Array);
          bytes = raw;
          messageSigns++;
        } else {
          bytes = Uint8Array.from(
            getTransactionDecoder().decode(Buffer.from(text(raw), 'base64'))
              .messageBytes,
          );
          transactionSigns++;
        }
        const signed = await signBytes(vm.payer.keyPair.privateKey, bytes);
        (message ? voucherMessages : transactionMessages).add(
          createHash('sha256').update(bytes).digest('hex'),
        );
        if (
          !message &&
          (cut === CRASH_CUTS.CLOSE_BEFORE_CHECKPOINT ||
            cut === CRASH_CUTS.REFUND_BEFORE_CHECKPOINT)
        )
          await pause();
        return signed;
      }),
    );
  }
  async function handle(
    method: CrashCall,
    args: readonly unknown[],
    cut: CrashCut | undefined,
    pause: () => Promise<void>,
  ): Promise<unknown> {
    if (method === CRASH_CALLS.SIGN) return signing(args, cut, pause);
    if (method === CRASH_CALLS.ADMIT) {
      await financial.seller().open(text(args[0]));
      if (cut === CRASH_CUTS.OPEN_INCLUDED) await pause();
      return null;
    }
    if (method === CRASH_CALLS.GENESIS)
      return vm.network.slice('solana:'.length) + '111111111111';
    if (method === CRASH_CALLS.SLOT) return vm.slot();
    if (method === CRASH_CALLS.TIME) return vm.blockTime();
    if (method === CRASH_CALLS.BLOCKHASH) return vm.hints();
    if (method === CRASH_CALLS.EPOCH)
      return { absoluteSlot: vm.slot(), blockHeight: vm.height() };
    if (method === CRASH_CALLS.OLDEST) return vm.history.oldestSlot;
    if (method === CRASH_CALLS.ACCOUNT)
      return {
        context: { slot: vm.slot() },
        value: await vm.accountInfo(address(text(args[0])), vm.network),
      };
    if (method === CRASH_CALLS.HISTORY) {
      const config = crashObject(args[1]);
      assert.ok(typeof config.limit === 'number');
      return vm.history.signatures(
        text(args[0]),
        config.before === undefined ? undefined : text(config.before),
        config.limit,
      );
    }
    if (method === CRASH_CALLS.TRANSACTION) {
      const id = signature(text(args[0]));
      const found = vm.history.transaction(id);
      if (!found) return null;
      return crashObject(args[1]).encoding === 'base64'
        ? {
            ...found,
            transaction: [vm.history.encodedTransaction(id), 'base64'],
          }
        : found;
    }
    if (method === CRASH_CALLS.STATUSES) {
      assert.ok(Array.isArray(args[0]));
      return {
        context: { slot: vm.slot() },
        value: args[0].map((id) => {
          const found = vm.history.status(signature(text(id)));
          return found ? { ...found, confirmationStatus: 'finalized' } : null;
        }),
      };
    }
    if (method === CRASH_CALLS.SEND) {
      const sent = await vm.signer.sendTransaction(text(args[0]), vm.network);
      if (
        cut === CRASH_CUTS.CLOSE_INCLUDED ||
        cut === CRASH_CUTS.REFUND_INCLUDED
      )
        await pause();
      return sent;
    }
    return assert.fail('Unknown owned batch crash RPC');
  }
  return {
    financial,
    start(action: BatchCrashInput['action'], cut?: CrashCut) {
      return crashChild(
        {
          root: financial.root,
          terms: financial.terms,
          now,
          action,
          ...(cut ? { cut } : {}),
        },
        (method, args, pause) => handle(method, args, cut, pause),
        new URL('./batch-recovery-child.ts', import.meta.url),
      );
    },
    async fund() {
      await this.start(CRASH_ACTIONS.OPEN).result();
      await financial.seller().dispose();
    },
    grace() {
      now += (financial.terms.withdrawDelaySeconds + 10) * 1000;
      vm.time(now / 1000);
    },
    signs: () => ({ transactionSigns, messageSigns }),
    messages: () => ({
      transactionMessages: transactionMessages.size,
      voucherMessages: voucherMessages.size,
    }),
  };
}
