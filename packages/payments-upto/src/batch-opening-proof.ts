// Validates local never-created evidence without converting an unfunded reservation into a refund.
import { createHash } from 'node:crypto';

import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';

import {
  controlAddress,
  controlAtomic,
  controlHex,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import type { BatchRecord } from './batch-session-types';
import { BATCH_BUYER_CHECKPOINTS } from './constants';

export interface BatchOpeningAbsence {
  channelId: string;
  messageDigest: string;
  blockhash: string;
  openSlot: string;
  lastValidBlockHeight: string;
  checkedSlot: string;
  blockHeight: string;
}
export function openingMessage(record: BatchRecord) {
  if (record.opening)
    return Uint8Array.from(
      getTransactionDecoder().decode(
        Buffer.from(record.opening.deposit.transaction, 'base64'),
      ).messageBytes,
    );
  const saved = record.pending[BATCH_BUYER_CHECKPOINTS.OPENING_TRANSACTION];
  if (!saved) return sessionFail(SESSION_CODES.UNVERIFIED);
  const row = controlObject(JSON.parse(saved), ['message', 'signature']);
  if (typeof row.message !== 'string')
    return sessionFail(SESSION_CODES.UNVERIFIED);
  const bytes = Buffer.from(row.message, 'base64');
  if (!bytes.length || bytes.toString('base64') !== row.message)
    return sessionFail(SESSION_CODES.UNVERIFIED);
  return Uint8Array.from(bytes);
}
export const openingDigest = (message: Uint8Array) =>
  createHash('sha256').update(message).digest('hex');
export function batchOpeningAbsent(
  record: BatchRecord,
): BatchOpeningAbsence | undefined {
  const saved = record.pending[BATCH_BUYER_CHECKPOINTS.OPENING_ABSENT];
  if (!saved) return undefined;
  const row = controlObject(JSON.parse(saved), [
    'channelId',
    'messageDigest',
    'blockhash',
    'openSlot',
    'lastValidBlockHeight',
    'checkedSlot',
    'blockHeight',
  ]);
  const proof: BatchOpeningAbsence = {
    channelId: controlAddress(row.channelId),
    messageDigest: controlHex(row.messageDigest),
    blockhash: controlAddress(row.blockhash),
    openSlot: controlAtomic(row.openSlot),
    lastValidBlockHeight: controlAtomic(row.lastValidBlockHeight),
    checkedSlot: controlAtomic(row.checkedSlot),
    blockHeight: controlAtomic(row.blockHeight),
  };
  const message = openingMessage(record);
  if (
    !record.hints ||
    !unfundedOpening(record) ||
    record.channelId !== proof.channelId ||
    proof.messageDigest !== openingDigest(message) ||
    record.hints.blockhash !== proof.blockhash ||
    record.hints.slot !== proof.openSlot ||
    record.hints.lastValidBlockHeight !== proof.lastValidBlockHeight ||
    BigInt(proof.checkedSlot) < BigInt(proof.openSlot) ||
    BigInt(proof.blockHeight) <= BigInt(proof.lastValidBlockHeight) ||
    getCompiledTransactionMessageDecoder().decode(message).lifetimeToken !==
      proof.blockhash
  )
    return sessionFail(SESSION_CODES.UNVERIFIED);
  return proof;
}

export function unfundedOpening(record: BatchRecord) {
  return (
    !record.settlement &&
    !record.closing &&
    record.cumulativeAtomic === '0' &&
    Object.values(record.requests).every(
      (request) => !request.accepted && request.bill === null,
    ) &&
    !record.pending[BATCH_BUYER_CHECKPOINTS.WITHDRAWAL] &&
    !record.pending[BATCH_BUYER_CHECKPOINTS.WITHDRAWAL_INTENT]
  );
}
