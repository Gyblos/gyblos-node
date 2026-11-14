// Proves non-creation at an expired finalized bank; it never signs, broadcasts or synthesizes a refund.
import {
  address,
  blockhash,
  isSignature,
  type createSolanaRpc,
} from '@solana/kit';
import {
  createUptoChannelHistory,
  UPTO_FINAL_COMMITMENT,
} from 'x402-upto-metered';

import { TIMEOUTS } from '@gyblos/config';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { originalBatchOpening } from './batch-opening-original';
import {
  batchOpeningAbsent,
  openingDigest,
  unfundedOpening,
  type BatchOpeningAbsence,
} from './batch-opening-proof';
import type { BatchStore } from './batch-session-store';
import { beforeAbort } from './buyer-observation-rpc';
import { observationSdk } from './buyer-observation-sdk';
import { BATCH_BUYER_CHECKPOINTS } from './constants';
import { verifyPaymentNetwork } from './seller-network';

export async function resolveAbsentBatchOpening(
  store: BatchStore,
  rpc: ReturnType<typeof createSolanaRpc>,
  external?: AbortSignal,
) {
  const record = store.read();
  if (batchOpeningAbsent(record)) return true;
  if (!record.hints || !unfundedOpening(record)) return false;
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUTS.rpc),
    ...(external ? [external] : []),
  ]);
  await beforeAbort(signal, () =>
    verifyPaymentNetwork(rpc, record.terms.network),
  );
  const history = openingHistory(rpc, signal);
  const tip = await beforeAbort(signal, () => history.tip());
  if (
    typeof tip.slot !== 'bigint' ||
    typeof tip.height !== 'bigint' ||
    tip.slot < BigInt(record.hints.slot) ||
    tip.height < 0n
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (tip.height <= BigInt(record.hints.lastValidBlockHeight)) return false;
  const original = await originalBatchOpening(record);
  const valid = await beforeAbort(signal, () =>
    rpc
      .isBlockhashValid(blockhash(record.hints!.blockhash), {
        commitment: UPTO_FINAL_COMMITMENT,
        minContextSlot: tip.slot,
      })
      .send({ abortSignal: signal }),
  );
  if (
    !valid.context ||
    typeof valid.context.slot !== 'bigint' ||
    valid.context.slot < tip.slot ||
    typeof valid.value !== 'boolean'
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (valid.value) return false;
  if (
    !(await absentAtBank(
      rpc,
      original.channelId,
      record.hints.slot,
      valid.context.slot,
      history,
      signal,
    ))
  )
    return false;
  const proof: BatchOpeningAbsence = {
    channelId: original.channelId,
    messageDigest: openingDigest(original.message),
    blockhash: record.hints.blockhash,
    openSlot: record.hints.slot,
    lastValidBlockHeight: record.hints.lastValidBlockHeight,
    checkedSlot: String(valid.context.slot),
    blockHeight: String(tip.height),
  };
  signal.throwIfAborted();
  await store.update((state) => {
    state.channelId = original.channelId;
    state.pending[BATCH_BUYER_CHECKPOINTS.OPENING_ABSENT] =
      JSON.stringify(proof);
  });
  signal.throwIfAborted();
  return true;
}

async function absentAtBank(
  rpc: ReturnType<typeof createSolanaRpc>,
  channelId: string,
  openSlot: string,
  slot: bigint,
  history: ReturnType<typeof createUptoChannelHistory>,
  signal: AbortSignal,
) {
  const found = await beforeAbort(signal, () =>
    history.signatures(channelId, slot),
  );
  if (!found.complete) return sessionFail(SESSION_CODES.UNVERIFIED);
  // A successful unknown transaction is not evidence of absence, even if its receipt is unreadable.
  if (found.signatures.length) return false;
  const oldest = await beforeAbort(signal, () => history.oldestSlot());
  if (typeof oldest !== 'bigint' || oldest < 0n || oldest > BigInt(openSlot))
    return sessionFail(SESSION_CODES.UNVERIFIED);
  const account = await beforeAbort(signal, () =>
    rpc
      .getAccountInfo(address(channelId), {
        encoding: 'base64',
        commitment: UPTO_FINAL_COMMITMENT,
        minContextSlot: slot,
      })
      .send({ abortSignal: signal }),
  );
  if (
    !account.context ||
    typeof account.context.slot !== 'bigint' ||
    account.context.slot < slot
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (account.value !== null) return false;
  return true;
}

function openingHistory(
  rpc: ReturnType<typeof createSolanaRpc>,
  signal: AbortSignal,
) {
  const base = observationSdk(rpc, signal);
  return createUptoChannelHistory({
    ...base,
    minimumLedgerSlot: () => ({
      send: () => retainedSlot(() => base.minimumLedgerSlot().send(), signal),
    }),
    getFirstAvailableBlock: () => ({
      send: () =>
        retainedSlot(() => base.getFirstAvailableBlock().send(), signal),
    }),
    getSignaturesForAddress: (account, config) => ({
      send: async () => {
        const rows = await beforeAbort(signal, () =>
          base.getSignaturesForAddress(account, config).send(),
        );
        if (!Array.isArray(rows) || rows.length > config.limit)
          return sessionFail(SESSION_CODES.UNVERIFIED);
        for (const row of rows)
          if (
            !row ||
            typeof row !== 'object' ||
            !Object.hasOwn(row, 'err') ||
            !isSignature(row.signature) ||
            (row.err !== null &&
              typeof row.err !== 'string' &&
              (typeof row.err !== 'object' ||
                !row.err ||
                Array.isArray(row.err)))
          )
            return sessionFail(SESSION_CODES.UNVERIFIED);
        return rows;
      },
    }),
  });
}

async function retainedSlot(read: () => Promise<bigint>, signal: AbortSignal) {
  const value = await beforeAbort(signal, read);
  if (typeof value !== 'bigint' || value < 0n)
    return sessionFail(SESSION_CODES.UNVERIFIED);
  return value;
}
