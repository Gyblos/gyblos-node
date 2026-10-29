// Shared pieces of the in-memory payment reference: the synthetic ledger, fee policy, signing
// bytes and the checks both parties apply. Test support only; never moves funds.
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import { type PaymentErrorCode } from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAdmission,
  type PaymentAuthorization,
  type PaymentDescription,
  type PaymentReconciliation,
  type PaymentSettlement,
  type PaymentSplit,
  type PaymentTerms,
} from '@gyblos/protocol/payment';
import { paymentMemo } from '@gyblos/protocol/payment-binding';

import {
  CONTRACT_CEILING,
  type PaymentBalances,
  type PaymentEvent,
} from './payment-rig';

export const ATOMIC = /^(0|[1-9][0-9]*)$/;
const DIGEST = /^[0-9a-f]{64}$/;
export const FUNDS = 10n * CONTRACT_CEILING;
export const TERM_MS = 60_000;
// Synthetic start of the rig clock (epoch ms); a real harness may start at real time.
export const START_MS = 1_800_000_000_000;
const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MINT = 'mint-synthetic';
// The network fee policy both parties hold; terms naming anything else are refused.
const FEE = { protocolFeeBps: 300, treasury: 'treasury-synthetic' };

export interface Ledger {
  // The synthetic clock both parties read; only the rig's advance() moves it.
  now: number;
  balances: PaymentBalances;
  events: PaymentEvent[];
  // What actually happened on the synthetic chain, by transaction id.
  transactions: Map<string, Omit<PaymentSettlement, 'transaction'>>;
}

export interface JournalEntry extends PaymentReconciliation {
  maxAtomic: string;
}

export interface Channel extends PaymentAdmission {
  // The distribution the payer signed at open; settlement pays exactly these shares.
  splits: PaymentSplit[];
  settlement: PaymentSettlement | null;
}

export function fail(code: PaymentErrorCode): never {
  throw new PaymentError(code);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function description(name: string): PaymentDescription {
  return {
    network: NETWORK,
    mint: MINT,
    payTo: `payee-${name}`,
    feePayer: `fee-payer-${name}`,
    authorizer: `authorizer-${name}`,
    ...FEE,
  };
}

// A second seller whose every declared field differs from description('primary').
export const OTHER_SELLER: PaymentDescription = {
  ...description('other'),
  protocolFeeBps: FEE.protocolFeeBps + 1,
  treasury: 'treasury-other',
};

export function channelIdOf(payer: string, terms: PaymentTerms): string {
  return sha256(JSON.stringify([payer, terms.payTo, terms.requestDigest]));
}

// A payer key as a wallet would hold it; the address is the hex SPKI of its public key, so the
// server derives the verification key from the address alone.
export interface PayerKey {
  payer: string;
  privateKey: KeyObject;
}

export function newPayer(): PayerKey {
  const keys = generateKeyPairSync('ed25519');
  return {
    payer: keys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('hex'),
    privateKey: keys.privateKey,
  };
}

// What a payer signs to open a channel: the channel, the terms digest (the memo) and the
// distribution, like the open transaction's memo and recipient list.
async function openBytes(
  channelId: string,
  terms: PaymentTerms,
  splits: readonly PaymentSplit[],
): Promise<Buffer> {
  return Buffer.from(
    JSON.stringify([channelId, await paymentMemo(terms), splits]),
  );
}

export async function openChannel(
  key: PayerKey,
  terms: PaymentTerms,
  splits: readonly PaymentSplit[],
): Promise<PaymentAuthorization> {
  const channelId = channelIdOf(key.payer, terms);
  const signature = sign(
    null,
    await openBytes(channelId, terms, splits),
    key.privateKey,
  );
  return {
    channelId,
    payer: key.payer,
    requestDigest: terms.requestDigest,
    maxAtomic: terms.maxAtomic,
    payload: Buffer.from(
      JSON.stringify({ splits, signature: signature.toString('base64') }),
    ).toString('base64'),
  };
}

// The same open with its distribution replaced after the payer signed (no new signature).
export function withTamperedSplits(
  authorization: PaymentAuthorization,
  splits: readonly PaymentSplit[],
): PaymentAuthorization {
  const opened = JSON.parse(
    Buffer.from(authorization.payload, 'base64').toString('utf8'),
  ) as { signature: string };
  return {
    ...authorization,
    payload: Buffer.from(
      JSON.stringify({ splits, signature: opened.signature }),
    ).toString('base64'),
  };
}

// The distribution the payer actually signed, or null when the payload is not a valid open.
export async function signedSplits(
  authorization: PaymentAuthorization,
  terms: PaymentTerms,
): Promise<PaymentSplit[] | null> {
  const raw = Buffer.from(authorization.payload, 'base64');
  // Base64 decoding ignores trailing garbage; the payload must round-trip exactly.
  if (raw.toString('base64') !== authorization.payload) return null;
  const opened = JSON.parse(raw.toString('utf8')) as {
    splits: PaymentSplit[];
    signature: string;
  };
  const valid = verify(
    null,
    await openBytes(authorization.channelId, terms, opened.splits),
    createPublicKey({
      key: Buffer.from(authorization.payer, 'hex'),
      format: 'der',
      type: 'spki',
    }),
    Buffer.from(opened.signature, 'base64'),
  );
  return valid ? opened.splits : null;
}

export function trustedTerms(
  terms: PaymentTerms,
  payer: string,
  now: number,
): boolean {
  return (
    terms.network === NETWORK &&
    terms.mint === MINT &&
    terms.protocolFeeBps === FEE.protocolFeeBps &&
    terms.treasury === FEE.treasury &&
    terms.buyer === payer &&
    ATOMIC.test(terms.maxAtomic) &&
    BigInt(terms.maxAtomic) > 0n &&
    BigInt(terms.maxAtomic) <= CONTRACT_CEILING &&
    DIGEST.test(terms.requestDigest) &&
    terms.expiresAt > now
  );
}

export function confirmedReceipt(
  ledger: Ledger,
  entry: JournalEntry,
  settlement: PaymentSettlement,
  expectedChargedAtomic: string,
): boolean {
  const onChain = ledger.transactions.get(settlement.transaction);
  return (
    onChain !== undefined &&
    onChain.channelId === entry.channelId &&
    settlement.channelId === entry.channelId &&
    onChain.chargedAtomic === settlement.chargedAtomic &&
    onChain.refundedAtomic === settlement.refundedAtomic &&
    onChain.sellerAtomic === settlement.sellerAtomic &&
    onChain.feeAtomic === settlement.feeAtomic &&
    settlement.chargedAtomic === expectedChargedAtomic &&
    BigInt(onChain.chargedAtomic) + BigInt(onChain.refundedAtomic) ===
      BigInt(entry.maxAtomic)
  );
}
