// Verifies chain vouchers and the separate signatures that bind private journal metadata.
import { getBase58Encoder } from '@solana/kit';

import { REUSABLE_JOURNAL } from './constants';
import type {
  NeverOpenedRecord,
  ReusableChannelTerms,
  ReusableClosureRecord,
  ReusablePending,
  ReusableVoucher,
} from './reusable-journal-model';

export function termsMessage(terms: ReusableChannelTerms): Uint8Array {
  return new TextEncoder().encode(
    'gyblos/reusable-terms/v1\n' + JSON.stringify(terms),
  );
}
export async function verifyTerms(
  terms: ReusableChannelTerms,
  signature: string,
): Promise<boolean> {
  try {
    const encoder = getBase58Encoder();
    const bytes = Uint8Array.from(encoder.encode(signature));
    const keyBytes = Uint8Array.from(encoder.encode(terms.buyer));
    if (
      bytes.length !== REUSABLE_JOURNAL.signatureBytes ||
      keyBytes.length !== REUSABLE_JOURNAL.addressBytes
    )
      return false;
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      'Ed25519',
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      bytes,
      Uint8Array.from(termsMessage(terms)),
    );
  } catch {
    return false;
  }
}
export function neverOpenedMessage(
  terms: ReusableChannelTerms,
  evidence: Pick<NeverOpenedRecord, 'contextSlot' | 'finalizedBlockHeight'>,
): Uint8Array {
  return new TextEncoder().encode(
    'gyblos/reusable-never-opened/v1\n' +
      JSON.stringify({
        terms,
        contextSlot: evidence.contextSlot,
        finalizedBlockHeight: evidence.finalizedBlockHeight,
      }),
  );
}
export async function verifyNeverOpened(
  terms: ReusableChannelTerms,
  evidence: NeverOpenedRecord,
): Promise<boolean> {
  try {
    const encoder = getBase58Encoder();
    const signature = Uint8Array.from(encoder.encode(evidence.signature));
    const keyBytes = Uint8Array.from(encoder.encode(terms.buyer));
    if (
      signature.length !== REUSABLE_JOURNAL.signatureBytes ||
      keyBytes.length !== REUSABLE_JOURNAL.addressBytes
    )
      return false;
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      'Ed25519',
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      signature,
      Uint8Array.from(neverOpenedMessage(terms, evidence)),
    );
  } catch {
    return false;
  }
}
export function closureMessage(
  terms: ReusableChannelTerms,
  evidence: Omit<ReusableClosureRecord, 'signature'>,
): Uint8Array {
  return new TextEncoder().encode(
    'gyblos/reusable-closed/v1\n' + JSON.stringify({ terms, ...evidence }),
  );
}
export async function verifyClosure(
  terms: ReusableChannelTerms,
  evidence: ReusableClosureRecord,
): Promise<boolean> {
  try {
    const encoder = getBase58Encoder();
    const signature = Uint8Array.from(encoder.encode(evidence.signature));
    const keyBytes = Uint8Array.from(encoder.encode(terms.buyer));
    if (
      signature.length !== REUSABLE_JOURNAL.signatureBytes ||
      keyBytes.length !== REUSABLE_JOURNAL.addressBytes
    )
      return false;
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      'Ed25519',
      false,
      ['verify'],
    );
    const { signature: _signature, ...data } = evidence;
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      signature,
      Uint8Array.from(closureMessage(terms, data)),
    );
  } catch {
    return false;
  }
}
// Separate local signature binds the application request and original terms; the chain voucher does not.
export function bindingMessage(
  terms: ReusableChannelTerms,
  item: Pick<ReusablePending, 'requestDigest' | 'maxClaimableAmount'>,
): Uint8Array {
  return new TextEncoder().encode(
    'gyblos/reusable-journal-binding/v1\n' +
      JSON.stringify({
        terms,
        requestDigest: item.requestDigest,
        maxClaimableAmount: item.maxClaimableAmount,
      }),
  );
}
export async function verifyBinding(
  terms: ReusableChannelTerms,
  item: ReusablePending,
): Promise<boolean> {
  try {
    const encoder = getBase58Encoder();
    const signature = Uint8Array.from(encoder.encode(item.bindingSignature));
    const keyBytes = Uint8Array.from(encoder.encode(terms.buyer));
    if (
      signature.length !== REUSABLE_JOURNAL.signatureBytes ||
      keyBytes.length !== REUSABLE_JOURNAL.addressBytes
    )
      return false;
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      'Ed25519',
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      signature,
      Uint8Array.from(bindingMessage(terms, item)),
    );
  } catch {
    return false;
  }
}
export async function verifyVoucher(
  entry: ReusableChannelTerms,
  item: ReusableVoucher,
): Promise<boolean> {
  try {
    const encoder = getBase58Encoder();
    const signature = Uint8Array.from(encoder.encode(item.signature));
    const channel = Uint8Array.from(encoder.encode(entry.channelId));
    const keyBytes = Uint8Array.from(encoder.encode(entry.buyer));
    if (
      signature.length !== REUSABLE_JOURNAL.signatureBytes ||
      channel.length !== REUSABLE_JOURNAL.addressBytes
    )
      return false;
    const message = new Uint8Array(REUSABLE_JOURNAL.voucherBytes);
    message[0] = REUSABLE_JOURNAL.voucherPrefix;
    message[1] = REUSABLE_JOURNAL.voucherVersion;
    message.set(channel, 2);
    new DataView(message.buffer).setBigUint64(
      REUSABLE_JOURNAL.voucherAmountOffset,
      BigInt(item.maxClaimableAmount),
      true,
    );
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      'Ed25519',
      false,
      ['verify'],
    );
    const binding = Uint8Array.from(encoder.encode(item.bindingSignature));
    if (binding.length !== REUSABLE_JOURNAL.signatureBytes) return false;
    return (
      (await crypto.subtle.verify('Ed25519', key, signature, message)) &&
      (await crypto.subtle.verify(
        'Ed25519',
        key,
        binding,
        Uint8Array.from(bindingMessage(entry, item)),
      ))
    );
  } catch {
    return false;
  }
}
