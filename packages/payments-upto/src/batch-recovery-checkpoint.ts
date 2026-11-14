// Maps guarded SDK withdrawal checkpoints onto the existing batch pending map; no alternate journal.
import { blockhash, getCompiledTransactionMessageDecoder } from '@solana/kit';
import {
  parseUptoWithdrawalAttempt,
  UPTO_CHANNEL_ACCOUNT,
  UPTO_FINAL_COMMITMENT,
  type UptoWithdrawalRecovery,
} from 'x402-upto-metered';

import { TIMEOUTS } from '@gyblos/config';
import {
  controlAtomic,
  controlObject,
  controlText,
} from '@gyblos/protocol/control-validation';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import {
  decodeControlWire,
  validateControlIntent,
  validateControlSignature,
  type BatchControlIntent,
} from './batch-recovery-wire';
import type { BatchStore } from './batch-session-store';
import type { BatchBuyerOptions } from './batch-session-types';
import { beforeAbort } from './buyer-observation-rpc';
import {
  BATCH_BUYER_CHECKPOINTS,
  BATCH_OPENING_LIMITS,
  WITHDRAW_STEPS,
} from './constants';
import type { UptoWithdrawRpc } from './withdrawal';

function parseIntent(raw: string): BatchControlIntent {
  const input: unknown = JSON.parse(raw);
  const row = controlObject(input, [
    'step',
    'wire',
    'lastValidBlockHeight',
    'checkedSlot',
  ]);
  if (
    row.step !== WITHDRAW_STEPS.CLOSE_REQUESTED &&
    row.step !== WITHDRAW_STEPS.DISTRIBUTED
  )
    return sessionFail(SESSION_CODES.BINDING);
  return {
    step: row.step,
    wire: controlText(row.wire, BATCH_OPENING_LIMITS.bytes),
    lastValidBlockHeight: controlAtomic(row.lastValidBlockHeight),
    checkedSlot: controlAtomic(row.checkedSlot),
  };
}
export async function retireCompletedControlIntent(
  store: BatchStore,
  status: number,
  rpc: UptoWithdrawRpc,
  payer: BatchBuyerOptions['payer'],
  external?: AbortSignal,
) {
  const saved = store.read().pending[BATCH_BUYER_CHECKPOINTS.WITHDRAWAL_INTENT];
  if (!saved) return;
  const intent = parseIntent(saved);
  await validateControlIntent(store.read(), payer, intent);
  const completed =
    intent.step === WITHDRAW_STEPS.CLOSE_REQUESTED &&
    (status === UPTO_CHANNEL_ACCOUNT.statuses.CLOSING ||
      status === UPTO_CHANNEL_ACCOUNT.statuses.SEALED ||
      status === UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED);
  if (completed || (await expiredIntent(rpc, intent, external)))
    await store.pending.delete(BATCH_BUYER_CHECKPOINTS.WITHDRAWAL_INTENT);
}

async function expiredIntent(
  rpc: UptoWithdrawRpc,
  intent: BatchControlIntent,
  external?: AbortSignal,
) {
  if (!rpc.getEpochInfo) return sessionFail(SESSION_CODES.UNVERIFIED);
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUTS.rpc),
    ...(external ? [external] : []),
  ]);
  const tip = await beforeAbort(signal, () =>
    rpc.getEpochInfo!({ commitment: UPTO_FINAL_COMMITMENT }).send({
      abortSignal: signal,
    }),
  );
  if (
    typeof tip.absoluteSlot !== 'bigint' ||
    typeof tip.blockHeight !== 'bigint' ||
    tip.absoluteSlot < BigInt(intent.checkedSlot) ||
    tip.blockHeight < 0n
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  // A lost signer reply may have escaped. Only finalized expiry ends that message's authority.
  return tip.blockHeight > BigInt(intent.lastValidBlockHeight);
}
export async function batchRecoveryCheckpoint(
  store: BatchStore,
  payer: BatchBuyerOptions['payer'],
  signal?: AbortSignal,
) {
  const saved = store.read().pending[BATCH_BUYER_CHECKPOINTS.WITHDRAWAL];
  const record = saved
    ? controlObject(JSON.parse(saved), ['attempt', 'wire'])
    : undefined;
  const previous = record
    ? parseUptoWithdrawalAttempt(record.attempt)
    : undefined;
  if (record && previous) {
    const wire = controlText(record.wire, BATCH_OPENING_LIMITS.bytes);
    await validateControlSignature(payer, previous, wire);
    await validateControlIntent(store.read(), payer, { ...previous, wire });
  }
  const pending =
    store.read().pending[BATCH_BUYER_CHECKPOINTS.WITHDRAWAL_INTENT];
  const intent = pending ? parseIntent(pending) : undefined;
  if (intent) await validateControlIntent(store.read(), payer, intent);
  const recovery = controlCallbacks(
    store,
    payer,
    record?.wire,
    previous,
    intent,
    signal,
  );
  return {
    recovery,
    pending:
      record && previous?.pending
        ? {
            attempt: previous,
            wire: controlText(record.wire, BATCH_OPENING_LIMITS.bytes),
          }
        : undefined,
    // An interrupted unsigned attempt may only rebuild its original lifetime/message.
    lifetime: intent
      ? {
          blockhash: blockhash(getLifetime(intent)),
          lastValidBlockHeight: BigInt(intent.lastValidBlockHeight),
        }
      : undefined,
  };
}

function controlCallbacks(
  store: BatchStore,
  payer: BatchBuyerOptions['payer'],
  wire: unknown,
  previous: UptoWithdrawalRecovery['previous'],
  intent: BatchControlIntent | undefined,
  signal?: AbortSignal,
) {
  return {
    previous,
    async save(attempt) {
      if (
        typeof wire !== 'string' ||
        !previous ||
        attempt.transaction !== previous.transaction
      )
        return sessionFail(SESSION_CODES.BINDING);
      await store.pending.set(
        BATCH_BUYER_CHECKPOINTS.WITHDRAWAL,
        JSON.stringify({
          attempt: parseUptoWithdrawalAttempt(attempt),
          wire,
        }),
      );
    },
    async prepare(next) {
      signal?.throwIfAborted();
      await validateControlIntent(store.read(), payer, next);
      if (
        intent &&
        !Buffer.from(decodeControlWire(intent.wire).messageBytes).equals(
          Buffer.from(decodeControlWire(next.wire).messageBytes),
        )
      )
        return sessionFail(SESSION_CODES.BINDING);
      await store.pending.set(
        BATCH_BUYER_CHECKPOINTS.WITHDRAWAL_INTENT,
        JSON.stringify(next),
      );
    },
    async signed(attempt, wire) {
      signal?.throwIfAborted();
      await validateControlSignature(payer, attempt, wire);
      const prepared =
        store.read().pending[BATCH_BUYER_CHECKPOINTS.WITHDRAWAL_INTENT];
      if (!prepared) return sessionFail(SESSION_CODES.UNVERIFIED);
      const original = parseIntent(prepared);
      if (
        original.step !== attempt.step ||
        original.lastValidBlockHeight !== attempt.lastValidBlockHeight ||
        !Buffer.from(decodeControlWire(original.wire).messageBytes).equals(
          Buffer.from(decodeControlWire(wire).messageBytes),
        )
      )
        return sessionFail(SESSION_CODES.BINDING);
      await store.update((state) => {
        state.pending[BATCH_BUYER_CHECKPOINTS.WITHDRAWAL] = JSON.stringify({
          attempt,
          wire,
        });
        delete state.pending[BATCH_BUYER_CHECKPOINTS.WITHDRAWAL_INTENT];
      });
      signal?.throwIfAborted();
    },
  } satisfies UptoWithdrawalRecovery;
}

function getLifetime(intent: BatchControlIntent) {
  // The blockhash is carried by the signed message, not trusted caller metadata.
  const transaction = decodeControlWire(intent.wire);
  return getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
    .lifetimeToken;
}
