// Submits a buyer close request only after its intent and signed wire are private and durable.
// This experimental path does not authenticate its caller-supplied observations.
import { createHash } from 'node:crypto';

import {
  assertIsTransactionWithinSizeLimit,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  type Base64EncodedWireTransaction,
  type MessagePartialSigner,
  type TransactionPartialSigner,
} from '@solana/kit';

import { DEVNET, TIMEOUTS } from '@gyblos/config';

import { beforeAbort } from './buyer-observation-rpc';
import { REUSABLE_CONTROL, REUSABLE_JOURNAL_STATES } from './constants';
import { closeMessage, verifyCloseSignature } from './reusable-control-message';
import { atomic, unavailable } from './reusable-journal-model';
import {
  findChannel,
  knownSettlement,
  verifyObservation,
} from './reusable-journal-observation';
import type {
  ReusableJournalSession,
  ReusableJournalStore,
} from './reusable-journal-store';
import type {
  FinalizedOpenObservation,
  ReusableChannelEntry,
  ReusableChannelTerms,
} from './reusable-journal-types';

export interface SubmitRecoveryAction {
  channelId: string;
  signer: MessagePartialSigner & TransactionPartialSigner;
  lifetime: { blockhash: string; lastValidBlockHeight: string };
  validateLifetime(
    network: string,
    lifetime: { blockhash: string; lastValidBlockHeight: string },
    signal: AbortSignal,
  ): Promise<{
    network: string;
    blockhash: string;
    lastValidBlockHeight: string;
    finalized: boolean;
    valid: boolean;
    latestSlot: string;
    validAtSlot: string;
  }>;
  read(terms: ReusableChannelTerms): Promise<FinalizedOpenObservation>;
  send(wire: Base64EncodedWireTransaction): Promise<string>;
  signal?: AbortSignal;
}

function snapshotInput(input: SubmitRecoveryAction) {
  return {
    channelId: input.channelId,
    signer: {
      address: input.signer.address,
      signMessages: input.signer.signMessages.bind(input.signer),
      signTransactions: input.signer.signTransactions.bind(input.signer),
    },
    lifetime: { ...input.lifetime },
    validateLifetime: input.validateLifetime.bind(input),
    read: input.read.bind(input),
    send: input.send.bind(input),
  };
}
type FixedInput = ReturnType<typeof snapshotInput>;

async function prepareClose(
  entry: ReusableChannelEntry,
  fixed: FixedInput,
  signal: AbortSignal,
) {
  const validity = await beforeAbort(signal, () =>
    fixed.validateLifetime(entry.terms.network, { ...fixed.lifetime }, signal),
  );
  if (
    !validity ||
    validity.network !== entry.terms.network ||
    validity.blockhash !== fixed.lifetime.blockhash ||
    validity.lastValidBlockHeight !==
      atomic(fixed.lifetime.lastValidBlockHeight) ||
    validity.finalized !== true ||
    validity.valid !== true ||
    BigInt(atomic(validity.validAtSlot)) < BigInt(atomic(validity.latestSlot))
  )
    unavailable();
  const observed = await beforeAbort(signal, () =>
    fixed.read(structuredClone(entry.terms)),
  );
  if (BigInt(atomic(observed.contextSlot)) < BigInt(validity.validAtSlot))
    unavailable();
  verifyObservation(
    entry.terms,
    observed,
    entry.authorizedAtomic,
    entry.lastObservedSlot,
  );
  if (
    !knownSettlement(entry, observed.settledAtomic) ||
    !knownSettlement(entry, observed.paidAtomic)
  )
    unavailable();
  if (signal.aborted) unavailable();
  return closeMessage(fixed.signer, entry.terms.channelId, fixed.lifetime);
}

async function executeClose(
  session: ReusableJournalSession,
  fixed: FixedInput,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) unavailable();
  const entry = findChannel(session.entries, fixed.channelId);
  if (
    entry.status !== REUSABLE_JOURNAL_STATES.READY ||
    entry.terms.network !== DEVNET ||
    fixed.signer.address !== entry.terms.buyer ||
    session.entries.some((item) => item.pending !== null)
  )
    unavailable();
  const { message, bytes } = await prepareClose(entry, fixed, signal);
  const intent = {
    version: REUSABLE_CONTROL.version,
    phase: REUSABLE_CONTROL.preparing,
    channelId: entry.terms.channelId,
    buyer: entry.terms.buyer,
    network: entry.terms.network,
    messageDigest: createHash('sha256').update(bytes).digest('hex'),
    blockhash: fixed.lifetime.blockhash,
    lastValidBlockHeight: fixed.lifetime.lastValidBlockHeight,
  };
  await session.saveControl(JSON.stringify(intent));
  if (signal.aborted) unavailable();
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithinSizeLimit(signed);
  if (!Buffer.from(signed.messageBytes).equals(Buffer.from(bytes)))
    unavailable();
  const signature = String(getSignatureFromTransaction(signed));
  if (!(await verifyCloseSignature(fixed.signer.address, bytes, signature)))
    unavailable();
  const wire = getBase64EncodedWireTransaction(signed);
  await session.saveControl(
    JSON.stringify({
      ...intent,
      phase: REUSABLE_CONTROL.pending,
      signature,
      wire,
    }),
  );
  if (signal.aborted) unavailable();
  const returned = await beforeAbort(signal, () => fixed.send(wire));
  if (returned !== signature) unavailable();
  return signature;
}

export function submitRecoveryAction(
  store: ReusableJournalStore,
  input: SubmitRecoveryAction,
): Promise<string> {
  const fixed = snapshotInput(input);
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUTS.rpc),
    ...(input.signal ? [input.signal] : []),
  ]);
  return store.run((session) => executeClose(session, fixed, signal));
}
