// Cuts a real buyer child at owned checkpoints; VM, history and custody survive in the parent.
// No lock/journal cleanup is used to recover; only normal APIs reopen and reconcile the same home.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { address } from '@solana/kit';
import { UPTO_PROGRAM, UPTO_WITHDRAW } from 'x402-upto-metered';

import { buyerJournalPathsIn, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { BUYER_JOURNAL } from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import { readPrivateFile } from '@gyblos/runtime/private-file';

import { crashChain } from './channel-crash-chain';
import {
  CRASH_ACTIONS,
  CRASH_CUTS,
  type CrashAction,
  type CrashCut,
} from './channel-crash-constants';
import { crashChild } from './channel-crash-process';
import { parseCrashState, type CrashState } from './channel-crash-protocol';
import { crashObject } from './channel-crash-rpc';
import type { NativeBalances } from './paid-native-channel';

export interface ChannelCrashReport {
  signal: NodeJS.Signals | null;
  retainedIdentity: boolean;
  replacementSignatures: number;
  replacementSends: number;
  totalSends: number;
  startupBlocked: boolean;
  chargedAtomic: string;
  balances: NativeBalances;
}

export async function crashFixture() {
  const chain = await crashChain();
  const root = await mkdtemp(join(tmpdir(), 'gyb-channel-crash-'));
  const workers = new Set<ReturnType<typeof crashChild>>();
  let failure: unknown;
  const start = (action: CrashAction, cut?: CrashCut) => {
    const worker = crashChild(
      {
        root,
        now: chain.now(),
        terms: chain.terms,
        expectedAtomic: chain.expected(),
        action,
        ...(cut ? { cut } : {}),
      },
      async (method, args, pause) => {
        try {
          return await chain.handle(method, args, cut, pause);
        } catch (error) {
          failure = error;
          throw error;
        }
      },
    );
    workers.add(worker);
    return worker;
  };
  const run = async (action: CrashAction) => {
    const worker = start(action);
    try {
      return await worker.result();
    } catch (error) {
      if (failure) throw failure;
      throw error;
    } finally {
      await worker.kill();
      workers.delete(worker);
    }
  };
  const saved = async (): Promise<CrashState | null> => {
    const source = await readPrivateFile(
      buyerJournalPathsIn({ GYBLOS_HOME: root }).state,
      BUYER_JOURNAL.maxBytes,
    );
    if (source === undefined) return null;
    const value: unknown = JSON.parse(source);
    const document = crashObject(value);
    assert.ok(Array.isArray(document.entries));
    return parseCrashState(document.entries[0] ?? null);
  };
  const balances = async (): Promise<NativeBalances> => {
    const vm = chain.vm;
    const entry = await saved();
    return {
      payer: await vm.balance(vm.payer.address),
      seller: await vm.balance(vm.seller.address),
      fee: await vm.balance(vm.fee.address),
      program: await vm.balance(UPTO_PROGRAM.treasuryOwners.mainnet),
      escrow: entry?.channelId ? await vm.balance(entry.channelId) : 0n,
    };
  };
  return {
    ...chain,
    root,
    start,
    run,
    saved,
    balances,
    mature: () => chain.advance(1_000_000),
    grace: () =>
      chain.advance(
        (UPTO_CHANNEL_SETTINGS.withdrawDelaySeconds +
          UPTO_WITHDRAW.graceMarginSeconds +
          1) *
          1000,
      ),
    async close() {
      await Promise.all(
        [...workers].map(async (worker) => {
          await worker.kill();
        }),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function runChannelCrash(
  cut: CrashCut,
): Promise<ChannelCrashReport> {
  const value = await crashFixture();
  try {
    const isOpening = cut.startsWith('open-');
    const isRefund = cut.startsWith('refund-');
    if (!isOpening) {
      await value.run(CRASH_ACTIONS.OPEN);
      value.mature();
      if (isRefund) {
        await value.run(CRASH_ACTIONS.WITHDRAW);
        await value.run(CRASH_ACTIONS.OBSERVE);
        value.grace();
      }
    }
    if (cut === CRASH_CUTS.REFUND_RESOLVED) {
      const lostReply = value.start(
        CRASH_ACTIONS.WITHDRAW,
        CRASH_CUTS.REFUND_INCLUDED,
      );
      await lostReply.reached();
      assert.equal(await lostReply.kill(), 'SIGKILL');
    }
    const victim = value.start(
      cut === CRASH_CUTS.REFUND_RESOLVED
        ? CRASH_ACTIONS.OBSERVE
        : isOpening
          ? CRASH_ACTIONS.OPEN
          : CRASH_ACTIONS.WITHDRAW,
      cut,
    );
    await victim.reached();
    const original = await value.saved();
    const signal = await victim.kill();
    assert.equal(signal, 'SIGKILL');
    if (cut === CRASH_CUTS.REFUND_SETTLED) {
      assert.equal(original?.state, PAYMENT_CHANNEL_STATES.SETTLED);
      assert.equal(original?.withdrawal?.pending, true);
    }
    if (cut === CRASH_CUTS.REFUND_RESOLVED) {
      assert.equal(original?.state, PAYMENT_CHANNEL_STATES.OPEN);
      assert.equal(original?.withdrawal?.pending, false);
    }
    const beforeSigns = value.signs();
    const beforeSends = value.vm.sends();
    let recovered = await value.run(CRASH_ACTIONS.OBSERVE);
    if (
      original?.channelId &&
      (original.state === PAYMENT_CHANNEL_STATES.OPEN ||
        original.withdrawal?.pending)
    )
      assert.equal(recovered.runtimeBlockedBefore, true);
    const replacementSignatures = value.signs() - beforeSigns;
    const replacementSends = value.vm.sends() - beforeSends;
    const retainedIdentity =
      recovered.entry?.channelId === original?.channelId &&
      (!original?.withdrawal ||
        recovered.entry?.withdrawal?.transaction ===
          original.withdrawal.transaction);
    if (
      recovered.entry?.withdrawal?.pending ||
      (isOpening && recovered.startupBlocked && value.vm.sends() === 0)
    ) {
      assert.equal(recovered.startupBlocked, true);
      await value.expire();
      recovered = await value.run(CRASH_ACTIONS.OBSERVE);
    }
    // Recovery calls inspect first. Further explicit invocations may close/refund only after proof.
    for (let attempt = 0; recovered.startupBlocked && attempt < 4; attempt++) {
      value.grace();
      await value.run(CRASH_ACTIONS.WITHDRAW);
      recovered = await value.run(CRASH_ACTIONS.OBSERVE);
    }
    if (recovered.entry?.channelId) {
      assert.equal(recovered.entry.state, PAYMENT_CHANNEL_STATES.SETTLED);
      assert.equal(recovered.entry.chargedAtomic, '0');
      const found = await value.vm.accountInfo(
        address(recovered.entry.channelId),
        value.vm.network,
      );
      if (found)
        assert.equal(await value.vm.balance(recovered.entry.channelId), 0n);
    }
    return {
      signal,
      retainedIdentity,
      replacementSignatures,
      replacementSends,
      totalSends: value.vm.sends(),
      startupBlocked: recovered.startupBlocked,
      chargedAtomic: recovered.entry?.chargedAtomic ?? '0',
      balances: await value.balances(),
    };
  } finally {
    await value.close();
  }
}
