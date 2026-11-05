// Resolves an unbuilt opening only with complete finalized archival buyer history.
// This trusted reader must independently scan every transaction in the specified range.
import { createSignableMessage, getBase58Decoder } from '@solana/kit';
import type { BatchClientSigner } from '@x402/svm/batch-settlement/client';

import { REUSABLE_JOURNAL_STATES, REUSABLE_OPEN_WIRE } from './constants';
import { termsMessage } from './reusable-journal-crypto';
import {
  atomic,
  unavailable,
  type PreparationObservation,
  type PreparedOpeningObservation,
  type ReusableChannelTerms,
} from './reusable-journal-model';
import { findChannel } from './reusable-journal-observation';
import type { ReusableJournalStore } from './reusable-journal-store';
import { openingTermsFromMessage } from './reusable-open-transaction';

function recoverPreparedOpening(
  store: ReusableJournalStore,
  buyer: string,
  read: (terms: ReusableChannelTerms) => Promise<PreparedOpeningObservation>,
  signer: BatchClientSigner,
): Promise<ReusableChannelTerms> {
  return store.run(async ({ entries, save }) => {
    const entry = findChannel(entries, buyer);
    const terms = entry.terms;
    if (
      entry.status !== REUSABLE_JOURNAL_STATES.PREPARING ||
      terms.buyer !== buyer ||
      signer.address !== buyer
    )
      unavailable();
    const result = await read(structuredClone(terms));
    if (
      !result ||
      result.network !== terms.network ||
      result.buyer !== buyer ||
      result.finalized !== true ||
      result.transactionSucceeded !== true ||
      BigInt(atomic(result.transactionSlot)) < BigInt(terms.openSlot) ||
      BigInt(result.transactionSlot) >
        BigInt(atomic(result.finalizedTipSlot)) ||
      !(result.messageBytes instanceof Uint8Array) ||
      result.messageBytes.length > REUSABLE_OPEN_WIRE.maxMessageBytes
    )
      unavailable();
    const recovered = await openingTermsFromMessage(
      Uint8Array.from(result.messageBytes),
      terms,
    );
    if (
      entries.some(
        (item) =>
          item !== entry && item.terms.channelId === recovered.channelId,
      )
    )
      unavailable();
    const [signature] = await signer.signMessages([
      createSignableMessage(termsMessage(recovered)),
    ]);
    const bytes = signature?.[signer.address];
    if (!bytes) unavailable();
    entry.terms = recovered;
    entry.termsSignature = getBase58Decoder().decode(bytes);
    entry.status = REUSABLE_JOURNAL_STATES.OPENING;
    await save();
    return structuredClone(recovered);
  });
}
// An asserted absence is insufficient to establish that no opening landed.
function recoverPreparation(): Promise<void> {
  return Promise.resolve().then(unavailable);
}
export function createPreparationActions(store: ReusableJournalStore) {
  return {
    recoverPreparedOpening: (
      buyer: string,
      read: (
        terms: ReusableChannelTerms,
      ) => Promise<PreparedOpeningObservation>,
      signer: BatchClientSigner,
    ) => recoverPreparedOpening(store, buyer, read, signer),
    recoverPreparation: (
      _buyer: string,
      _read: (terms: ReusableChannelTerms) => Promise<PreparationObservation>,
      _signer: BatchClientSigner,
    ) => recoverPreparation(),
  };
}
