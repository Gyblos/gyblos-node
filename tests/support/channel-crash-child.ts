// Owned crash victim: actual buyer/journal/withdrawal/reconciliation APIs over private parent IPC.
// SIGKILL victims never close their journal; clean observation runs return only sanitized state.
import assert from 'node:assert/strict';

import { createUptoHintReader, UptoError } from 'x402-upto-metered';

import { buyerJournalPathsIn, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import {
  createUptoPaymentClient,
  createUptoWithdrawal,
  hasUnresolvedBuyerPayments,
  openUptoBuyerJournal,
  reconcileUptoBuyer,
  uptoSettlementView,
  uptoTermsFor,
  withdrawUptoBuyer,
  type UptoBuyerJournal,
} from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import { isMain } from '@gyblos/runtime';

import {
  CHANNEL_CRASH,
  CRASH_ACTIONS,
  CRASH_CALLS,
  CRASH_CUTS,
  CRASH_FAILURE,
  CRASH_MESSAGES,
  type CrashCut,
} from './channel-crash-constants';
import {
  parseCrashInput,
  type CrashInput,
  type CrashReply,
} from './channel-crash-protocol';
import {
  crashObject,
  crashRpc,
  crashSigner,
  type CrashCallPort,
} from './channel-crash-rpc';

function childPort(): CrashCallPort {
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  process.on('message', (raw: unknown) => {
    const value = crashObject(raw);
    if (value.kind !== CRASH_MESSAGES.REPLY) return;
    assert.ok(typeof value.id === 'number' && typeof value.ok === 'boolean');
    const held = pending.get(value.id);
    assert.ok(held);
    pending.delete(value.id);
    if (value.ok) held.resolve(value.value);
    else held.reject(new Error(CRASH_FAILURE));
  });
  return (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      process.send!({ kind: CRASH_MESSAGES.CALL, id, method, args });
    });
}

function instrument(
  journal: UptoBuyerJournal,
  input: CrashInput,
  call: CrashCallPort,
): UptoBuyerJournal {
  const pause = async (cuts: readonly CrashCut[]) => {
    if (input.cut && cuts.includes(input.cut)) await call(CRASH_CALLS.CUT, []);
  };
  return {
    ...journal,
    async put(entry) {
      if (entry.channelId) await pause([CRASH_CUTS.OPEN_BEFORE_CHECKPOINT]);
      await journal.put(entry);
      if (entry.channelId) await pause([CRASH_CUTS.OPEN_CHECKPOINTED]);
    },
    async recordWithdrawal(digest, channel, expected, next) {
      assert.ok(journal.recordWithdrawal);
      const fresh = next.pending && !expected?.pending;
      if (fresh)
        await pause([
          CRASH_CUTS.CLOSE_BEFORE_CHECKPOINT,
          CRASH_CUTS.REFUND_BEFORE_CHECKPOINT,
        ]);
      await journal.recordWithdrawal(digest, channel, expected, next);
      if (fresh)
        await pause([
          CRASH_CUTS.CLOSE_CHECKPOINTED,
          CRASH_CUTS.REFUND_CHECKPOINTED,
        ]);
    },
  };
}

async function execute(
  input: CrashInput,
  call: CrashCallPort,
): Promise<CrashReply> {
  Date.now = () => input.now;
  const paths = buyerJournalPathsIn({ GYBLOS_HOME: input.root });
  const opened = await openUptoBuyerJournal({ paths, now: () => input.now });
  if (input.cut === CRASH_CUTS.RECOVERY_LOCKED) await call(CRASH_CALLS.CUT, []);
  const journal = instrument(opened, input, call);
  try {
    const rpc = crashRpc(call);
    const payer = crashSigner(input.terms.buyer, call);
    const bound = await uptoTermsFor(input.terms, UPTO_CHANNEL_SETTINGS);
    const hints = createUptoHintReader(rpc, bound.network);
    const policy = {
      network: input.terms.network,
      mint: input.terms.mint,
      treasury: input.terms.treasury,
      protocolFeeBps: input.terms.protocolFeeBps,
      maxAtomic: input.terms.maxAtomic,
    };
    const client = createUptoPaymentClient({
      payer,
      policy,
      journal,
      settings: UPTO_CHANNEL_SETTINGS,
      hints: hints.hints,
      confirm: uptoSettlementView(rpc, policy, payer),
      now: () => input.now,
    });
    const original = await journal.get(CHANNEL_CRASH.digest);
    const runtimeBlockedBefore = (await client.reconcile()).some(
      (row) => row.state !== PAYMENT_CHANNEL_STATES.SETTLED,
    );
    if (input.action === CRASH_ACTIONS.OPEN) {
      const authorization = await client.authorize(input.terms);
      if (input.cut === CRASH_CUTS.OPEN_SIGNED) await call(CRASH_CALLS.CUT, []);
      await call(CRASH_CALLS.ADMIT, [authorization]);
    } else if (input.action === CRASH_ACTIONS.OBSERVE && original) {
      await assert.rejects(
        client.authorize({ ...input.terms, expiresAt: input.now + 60_000 }),
        { code: PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED },
      );
    }
    if (
      input.action === CRASH_ACTIONS.WITHDRAW ||
      (input.action === CRASH_ACTIONS.OBSERVE && original?.withdrawal?.pending)
    ) {
      await withdrawUptoBuyer({
        ...policy,
        journal,
        withdrawal: createUptoWithdrawal(rpc, {
          payer,
          network: policy.network,
          tokenProgram: UPTO_CHANNEL_SETTINGS.tokenProgram,
          sleep: async () => {},
        }),
        maxTimeoutSeconds: UPTO_CHANNEL_SETTINGS.maxTimeoutSeconds,
        now: () => input.now,
        report: async () => {},
      });
    }
    if (input.cut === CRASH_CUTS.REFUND_RESOLVED)
      await call(CRASH_CALLS.CUT, []);
    const financial = await reconcileUptoBuyer({
      ...policy,
      journal,
      rpc,
      payer: payer.address,
      expected: () => input.expectedAtomic,
      report: async () => {},
    });
    if (input.cut === CRASH_CUTS.REFUND_SETTLED)
      await call(CRASH_CALLS.CUT, []);
    const entry = await journal.get(CHANNEL_CRASH.digest);
    const runtimeBlocked = (await client.reconcile()).some(
      (row) => row.state !== PAYMENT_CHANNEL_STATES.SETTLED,
    );
    await journal.close();
    return {
      runtimeBlockedBefore,
      entry: entry
        ? {
            channelId: entry.channelId,
            state: entry.state,
            chargedAtomic: entry.chargedAtomic,
            ...(entry.withdrawal ? { withdrawal: entry.withdrawal } : {}),
          }
        : null,
      financial: financial[0]
        ? {
            chargedAtomic: financial[0].chargedAtomic,
            refundedAtomic: financial[0].refundedAtomic,
          }
        : null,
      runtimeBlocked,
      startupBlocked: await hasUnresolvedBuyerPayments(paths),
    };
  } finally {
    await opened.close();
  }
}

async function main() {
  assert.ok(process.send);
  const call = childPort();
  process.once('message', (raw: unknown) => {
    const message = crashObject(raw);
    assert.equal(message.kind, CRASH_MESSAGES.INIT);
    void execute(parseCrashInput(message.input), call).then(
      (result) => {
        process.send!({ kind: CRASH_MESSAGES.DONE, ok: true, result }, () =>
          process.disconnect?.(),
        );
      },
      (error: unknown) => {
        const code =
          error instanceof PaymentError || error instanceof UptoError
            ? error.code
            : CRASH_FAILURE;
        process.send!({ kind: CRASH_MESSAGES.DONE, ok: false, code }, () =>
          process.disconnect?.(),
        );
      },
    );
  });
}

if (isMain(import.meta.url)) void main();
