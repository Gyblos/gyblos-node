// Continues only the original signed control transaction after a fresh finalized-bank observation.
// A missing reply never grants a new signature, blockhash, channel or inference request.
import { getBase64EncodedWireTransaction, signature } from '@solana/kit';
import {
  UPTO_COMMITMENT,
  UPTO_FINAL_COMMITMENT,
  type UptoWithdrawResult,
} from 'x402-upto-metered';

import { TIMEOUTS } from '@gyblos/config';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import type { batchRecoveryCheckpoint } from './batch-recovery-checkpoint';
import { decodeControlWire } from './batch-recovery-wire';
import { beforeAbort } from './buyer-observation-rpc';
import type { UptoWithdrawRpc } from './withdrawal';

export async function resumeBatchControl(
  rpc: UptoWithdrawRpc,
  pending: Awaited<ReturnType<typeof batchRecoveryCheckpoint>>['pending'],
  outcome: UptoWithdrawResult,
  external?: AbortSignal,
) {
  if (
    !pending ||
    outcome.confirmed ||
    outcome.transaction !== pending.attempt.transaction
  )
    return;
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
    tip.absoluteSlot < BigInt(pending.attempt.checkedSlot) ||
    tip.blockHeight < 0n
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (tip.blockHeight > BigInt(pending.attempt.lastValidBlockHeight)) return;
  const statuses = await beforeAbort(signal, () =>
    rpc
      .getSignatureStatuses([signature(pending.attempt.transaction)], {
        searchTransactionHistory: true,
      })
      .send({ abortSignal: signal }),
  );
  if (
    !statuses.context ||
    statuses.context.slot < tip.absoluteSlot ||
    statuses.value.length !== 1
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (statuses.value[0] !== null) return;
  const wire = getBase64EncodedWireTransaction(decodeControlWire(pending.wire));
  try {
    await beforeAbort(signal, () =>
      rpc
        .sendTransaction(wire, {
          encoding: 'base64',
          preflightCommitment: UPTO_COMMITMENT,
        })
        .send({ abortSignal: signal }),
    );
  } catch {
    // The retained signature remains pending. Only independent subsequent proof resolves it.
  }
}
