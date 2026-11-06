// Checks a retained buyer close against its exact signed wire and an injected chain reader.
// This experimental client does not authenticate that reader or prevent state rollback.
import { createHash } from 'node:crypto';

import {
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type MessagePartialSigner,
  type TransactionPartialSigner,
} from '@solana/kit';

import { DEVNET, TIMEOUTS } from '@gyblos/config';

import { beforeAbort } from './buyer-observation-rpc';
import { REUSABLE_CONTROL, REUSABLE_OPEN_WIRE } from './constants';
import { closeMessage, verifyCloseSignature } from './reusable-control-message';
import { findChannel } from './reusable-journal-observation';
import type { ReusableJournalStore } from './reusable-journal-store';

export interface RecoveryCloseObservation {
  network: string;
  transaction: string;
  finalized: boolean;
  succeeded: boolean;
  signedTransaction: Uint8Array;
}
export interface ResolveRecoveryAction {
  channelId: string;
  signer: MessagePartialSigner & TransactionPartialSigner;
  read(transaction: string): Promise<RecoveryCloseObservation | null>;
  signal?: AbortSignal;
}
export type RecoveryCloseResult =
  | typeof REUSABLE_CONTROL.confirmed
  | typeof REUSABLE_CONTROL.failed
  | typeof REUSABLE_CONTROL.unknown;

function pendingRecord(source: string) {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const keys = Object.keys(value).sort().join(',');
  if (
    keys !==
    [
      'blockhash',
      'buyer',
      'channelId',
      'lastValidBlockHeight',
      'messageDigest',
      'network',
      'phase',
      'signature',
      'version',
      'wire',
    ]
      .sort()
      .join(',')
  )
    return;
  const version: unknown = Reflect.get(value, 'version');
  const phase: unknown = Reflect.get(value, 'phase');
  const channelId: unknown = Reflect.get(value, 'channelId');
  const buyer: unknown = Reflect.get(value, 'buyer');
  const network: unknown = Reflect.get(value, 'network');
  const messageDigest: unknown = Reflect.get(value, 'messageDigest');
  const blockhash: unknown = Reflect.get(value, 'blockhash');
  const lastValidBlockHeight: unknown = Reflect.get(
    value,
    'lastValidBlockHeight',
  );
  const signature: unknown = Reflect.get(value, 'signature');
  const wire: unknown = Reflect.get(value, 'wire');
  if (
    version !== REUSABLE_CONTROL.version ||
    ![
      REUSABLE_CONTROL.pending,
      REUSABLE_CONTROL.confirmed,
      REUSABLE_CONTROL.failed,
    ].some((item) => item === phase) ||
    typeof channelId !== 'string' ||
    typeof buyer !== 'string' ||
    network !== DEVNET ||
    typeof messageDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(messageDigest) ||
    typeof blockhash !== 'string' ||
    typeof lastValidBlockHeight !== 'string' ||
    typeof signature !== 'string' ||
    typeof wire !== 'string' ||
    wire.length > REUSABLE_CONTROL.maxEncodedWireBytes
  )
    return;
  const record = {
    version,
    phase,
    channelId,
    buyer,
    network,
    messageDigest,
    blockhash,
    lastValidBlockHeight,
    signature,
    wire,
  };
  if (JSON.stringify(record) !== source) return;
  return record;
}

export function resolveRecoveryAction(
  store: ReusableJournalStore,
  input: ResolveRecoveryAction,
): Promise<RecoveryCloseResult> {
  const channelId = input.channelId;
  const signer = {
    address: input.signer.address,
    signMessages: input.signer.signMessages.bind(input.signer),
    signTransactions: input.signer.signTransactions.bind(input.signer),
  };
  const read = input.read.bind(input);
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUTS.rpc),
    ...(input.signal ? [input.signal] : []),
  ]);
  return store
    .run(async (session) => {
      const source = await session.readControl();
      if (source === undefined || signal.aborted)
        return REUSABLE_CONTROL.unknown;
      const record = pendingRecord(source);
      if (
        !record ||
        record.channelId !== channelId ||
        record.buyer !== signer.address
      )
        return REUSABLE_CONTROL.unknown;
      const entry = findChannel(session.entries, channelId);
      if (
        entry.terms.buyer !== record.buyer ||
        entry.terms.network !== record.network
      )
        return REUSABLE_CONTROL.unknown;
      const wire = Uint8Array.from(getBase64Encoder().encode(record.wire));
      if (
        wire.length > REUSABLE_OPEN_WIRE.maxMessageBytes ||
        Buffer.from(wire).toString('base64') !== record.wire
      )
        return REUSABLE_CONTROL.unknown;
      const transaction = getTransactionDecoder().decode(wire);
      const { bytes } = closeMessage(signer, channelId, record);
      const signature = String(getSignatureFromTransaction(transaction));
      if (
        signature !== record.signature ||
        !Buffer.from(transaction.messageBytes).equals(Buffer.from(bytes)) ||
        createHash('sha256').update(bytes).digest('hex') !==
          record.messageDigest ||
        !(await verifyCloseSignature(signer.address, bytes, signature))
      )
        return REUSABLE_CONTROL.unknown;
      const observed = await beforeAbort(signal, () => read(signature));
      if (
        !observed ||
        signal.aborted ||
        observed.network !== record.network ||
        observed.transaction !== signature ||
        observed.finalized !== true ||
        typeof observed.succeeded !== 'boolean' ||
        !(observed.signedTransaction instanceof Uint8Array) ||
        !Buffer.from(observed.signedTransaction).equals(Buffer.from(wire))
      )
        return REUSABLE_CONTROL.unknown;
      const phase = observed.succeeded
        ? REUSABLE_CONTROL.confirmed
        : REUSABLE_CONTROL.failed;
      if (record.phase !== REUSABLE_CONTROL.pending && record.phase !== phase)
        return REUSABLE_CONTROL.unknown;
      await session.saveControl(JSON.stringify({ ...record, phase }));
      return phase;
    }, true)
    .catch(() => REUSABLE_CONTROL.unknown);
}
