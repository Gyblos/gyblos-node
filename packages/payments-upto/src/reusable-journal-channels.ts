// Creates and checks reusable-channel records without sending an opening or observing a chain itself.
// The caller supplies an independent, current finalized reader and verified seller identity.
import { createSignableMessage, getBase58Decoder } from '@solana/kit';
import type { BatchClientSigner } from '@x402/svm/batch-settlement/client';

import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import {
  REUSABLE_JOURNAL,
  REUSABLE_JOURNAL_STATES,
  REUSABLE_OPEN_WIRE,
} from './constants';
import { termsMessage } from './reusable-journal-crypto';
import {
  parseTerms,
  unavailable,
  type NeverOpenedObservation,
  type ReusableChannelTerms,
} from './reusable-journal-model';
import { findChannel, verifyObservation } from './reusable-journal-observation';
import type { ReusableJournalStore } from './reusable-journal-store';
import type { ReusableObservationReader } from './reusable-journal-vouchers';
import { openingTermsFromMessage } from './reusable-open-transaction';

function sameRelationship(
  left: ReusableChannelTerms,
  right: ReusableChannelTerms,
): boolean {
  return (
    left.network === right.network &&
    left.mint === right.mint &&
    left.buyer === right.buyer &&
    left.sellerNodeId === right.sellerNodeId
  );
}
// Caller-supplied absence cannot prove an opening never happened.
function recoverNeverOpened(): Promise<void> {
  return Promise.resolve().then(unavailable);
}

function completeOpening(
  store: ReusableJournalStore,

  preparationId: string,
  messageBytes: Uint8Array,
  signer: BatchClientSigner,
): Promise<ReusableChannelTerms> {
  if (
    !(messageBytes instanceof Uint8Array) ||
    messageBytes.length > REUSABLE_OPEN_WIRE.maxMessageBytes
  )
    return Promise.reject(
      new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
    );
  const captured = Uint8Array.from(messageBytes);
  return store.run(async ({ entries, save }) => {
    const entry = findChannel(entries, preparationId);
    if (
      entry.status !== REUSABLE_JOURNAL_STATES.PREPARING ||
      signer.address !== entry.terms.buyer
    )
      unavailable();
    const terms = await openingTermsFromMessage(captured, entry.terms);
    if (
      entries.some(
        (item) => item !== entry && item.terms.channelId === terms.channelId,
      )
    )
      unavailable();
    const [signature] = await signer.signMessages([
      createSignableMessage(termsMessage(terms)),
    ]);
    const bytes = signature?.[signer.address];
    if (!bytes) unavailable();
    entry.terms = terms;
    entry.termsSignature = getBase58Decoder().decode(bytes);
    entry.status = REUSABLE_JOURNAL_STATES.OPENING;
    await save();
    return structuredClone(terms);
  });
}

function beginOpening(
  store: ReusableJournalStore,
  value: ReusableChannelTerms,
  signer: BatchClientSigner,
) {
  let terms: ReusableChannelTerms;
  try {
    terms = parseTerms(structuredClone(value));
  } catch {
    return Promise.reject(
      new PaymentError(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE),
    );
  }
  return store.run(async ({ entries, save }) => {
    if (
      entries.length >= REUSABLE_JOURNAL.maxChannels ||
      entries.some(
        (item) =>
          item.pending ||
          item.status === REUSABLE_JOURNAL_STATES.OPENING ||
          item.status === REUSABLE_JOURNAL_STATES.PREPARING,
      ) ||
      entries.some(
        (item) =>
          item.terms.channelId === terms.channelId ||
          (item.status !== REUSABLE_JOURNAL_STATES.NOT_OPENED &&
            sameRelationship(item.terms, terms)),
      ) ||
      signer.address !== terms.buyer ||
      terms.channelId !== terms.buyer ||
      terms.salt !== '0'
    )
      unavailable();
    const [signature] = await signer.signMessages([
      createSignableMessage(termsMessage(terms)),
    ]);
    const bytes = signature?.[signer.address];
    if (!bytes) unavailable();
    entries.push({
      termsSignature: getBase58Decoder().decode(bytes),
      terms,
      status: REUSABLE_JOURNAL_STATES.PREPARING,
      authorizedAtomic: '0',
      lastObservedSlot: '0',
      pending: null,
      terminal: null,
      vouchers: [],
    });
    await save();
  });
}

export function createReusableChannelActions(store: ReusableJournalStore) {
  return {
    beginOpening: (value: ReusableChannelTerms, signer: BatchClientSigner) =>
      beginOpening(store, value, signer),
    completeOpening(
      preparationId: string,
      messageBytes: Uint8Array,
      signer: BatchClientSigner,
    ): Promise<ReusableChannelTerms> {
      return completeOpening(store, preparationId, messageBytes, signer);
    },
    confirmOpen(channelId: string, read: ReusableObservationReader) {
      return store.run(async ({ entries, save }) => {
        const entry = findChannel(entries, channelId);
        if (entry.status !== REUSABLE_JOURNAL_STATES.OPENING) unavailable();
        const observed = await read(structuredClone(entry.terms));
        verifyObservation(entry.terms, observed, '0', entry.lastObservedSlot);
        entry.lastObservedSlot = observed.contextSlot;
        entry.status = REUSABLE_JOURNAL_STATES.READY;
        await save();
      });
    },
    recoverNeverOpened(
      _channelId: string,
      _read: (terms: ReusableChannelTerms) => Promise<NeverOpenedObservation>,
      _signer: BatchClientSigner,
    ): Promise<void> {
      return recoverNeverOpened();
    },
    get(channelId: string) {
      return store.run(async ({ entries }) =>
        structuredClone(
          entries.find((item) => item.terms.channelId === channelId),
        ),
      );
    },
    list() {
      return store.run(async ({ entries }) => structuredClone(entries));
    },
  };
}
