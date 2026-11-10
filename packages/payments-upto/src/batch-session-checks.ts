// Validates independent session terms and bounded private state; never accepts remote accounting as truth.
import type { PaymentRequirements } from '@x402/core/types';
import {
  BATCH_SETTLEMENT_SCHEME,
  isBatchFacilitatorPayload,
  isBatchPayload,
  SOLANA_DEVNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  TOKEN_PROGRAM_ADDRESS,
} from '@x402/svm';

import { UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import { PAYMENT_BINDING } from '@gyblos/protocol/constants';
import {
  controlAddress,
  controlAtomic,
  controlHex,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { paymentSplits } from '@gyblos/protocol/payment-binding';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type PaymentSessionTerms,
  type SessionBill,
  type SessionRequest,
  type SessionVoucher,
} from '@gyblos/protocol/payment-session';

import { coherentRecord } from './batch-session-consistency';
import type { BatchRecord } from './batch-session-types';
import { UPTO_BUYER_DISTINCT_PARTIES } from './constants';

export function atomic(value: unknown): string {
  return controlAtomic(value);
}
export function termsFor(value: unknown): PaymentSessionTerms {
  const row = controlObject(value, [
    'buyer',
    'buyerNodeId',
    'owner',
    'sellerNodeId',
    'network',
    'mint',
    'payTo',
    'feePayer',
    'authorizer',
    'treasury',
    'protocolFeeBps',
    'depositAtomic',
    'expiresAt',
    'withdrawDelaySeconds',
  ]);
  const terms: PaymentSessionTerms = {
    buyer: controlAddress(row.buyer),
    buyerNodeId: controlHex(row.buyerNodeId, PAYMENT_SESSION.digestBytes),
    owner: controlAddress(row.owner),
    sellerNodeId: controlHex(row.sellerNodeId, PAYMENT_SESSION.digestBytes),
    network: network(row.network),
    mint: controlAddress(row.mint),
    payTo: controlAddress(row.payTo),
    feePayer: controlAddress(row.feePayer),
    authorizer: controlAddress(row.authorizer),
    treasury: controlAddress(row.treasury),
    protocolFeeBps: controlInteger(
      row.protocolFeeBps,
      0,
      PAYMENT_BINDING.bpsDenominator,
    ),
    withdrawDelaySeconds: controlInteger(
      row.withdrawDelaySeconds,
      BATCH_SESSION_DEFAULTS.withdrawDelaySeconds,
    ),
    depositAtomic: atomic(row.depositAtomic),
    expiresAt: controlInteger(row.expiresAt, 1),
  };
  if (
    BigInt(terms.depositAtomic) === 0n ||
    new Set([terms.buyer, terms.payTo, terms.feePayer, terms.treasury]).size !==
      UPTO_BUYER_DISTINCT_PARTIES
  )
    sessionFail();
  return terms;
}
function network(value: unknown) {
  if (value === SOLANA_DEVNET_CAIP2 || value === SOLANA_TESTNET_CAIP2)
    return value;
  return sessionFail(SESSION_CODES.BINDING);
}
export function requestFor(value: unknown): SessionRequest {
  const row = controlObject(value, ['requestId', 'requestDigest', 'maxAtomic']);
  return {
    requestId: controlHex(row.requestId, PAYMENT_SESSION.requestIdBytes),
    requestDigest: controlHex(row.requestDigest, PAYMENT_SESSION.digestBytes),
    maxAtomic: atomic(row.maxAtomic),
  };
}
export function billFor(value: unknown): SessionBill {
  const row = controlObject(value, [
    'requestId',
    'requestDigest',
    'maxAtomic',
    'chargedAtomic',
    'cumulativeAtomic',
  ]);
  const request = requestFor({
    requestId: row.requestId,
    requestDigest: row.requestDigest,
    maxAtomic: row.maxAtomic,
  });
  const bill = {
    ...request,
    chargedAtomic: atomic(row.chargedAtomic),
    cumulativeAtomic: atomic(row.cumulativeAtomic),
  };
  if (BigInt(bill.chargedAtomic) > BigInt(request.maxAtomic))
    sessionFail(SESSION_CODES.LIMIT);
  return bill;
}
export function voucherFor(value: unknown): SessionVoucher {
  const row = controlObject(value, [
    'channelId',
    'maxClaimableAmount',
    'expiresAt',
    'signature',
  ]);
  if (
    row.expiresAt !== PAYMENT_SESSION.voucherExpiry ||
    typeof row.signature !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(row.signature)
  )
    sessionFail();
  return {
    channelId: controlAddress(row.channelId),
    maxClaimableAmount: atomic(row.maxClaimableAmount),
    expiresAt: row.expiresAt,
    signature: row.signature,
  };
}
export async function requirementsFor(
  terms: PaymentSessionTerms,
): Promise<PaymentRequirements> {
  const digest = Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(PAYMENT_SESSION.domain + canonicalJson(terms)),
    ),
  ).toString('hex');
  return {
    scheme: BATCH_SETTLEMENT_SCHEME,
    network: network(terms.network),
    asset: terms.mint,
    amount: '0',
    payTo: terms.payTo,
    maxTimeoutSeconds: UPTO_CHANNEL_SETTINGS.maxTimeoutSeconds,
    extra: {
      feePayer: terms.feePayer,
      receiverAuthorizer: terms.authorizer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: terms.withdrawDelaySeconds,
      memo: PAYMENT_SESSION.domain.trim() + ':' + digest,
      splits: paymentSplits(terms),
    },
  };
}
export function openingFor(value: unknown, terms: PaymentSessionTerms) {
  if (!isBatchPayload(value) || value.type !== 'deposit' || !value.voucher)
    return sessionFail();
  const config = value.channelConfig;
  if (
    config.payer !== terms.buyer ||
    config.payerAuthorizer !== terms.buyer ||
    config.receiver !== terms.payTo ||
    config.receiverAuthorizer !== terms.authorizer ||
    config.token !== terms.mint ||
    config.voucherSigner !== undefined ||
    config.withdrawDelay !== terms.withdrawDelaySeconds ||
    value.deposit.amount !== terms.depositAtomic ||
    value.voucher.maxClaimableAmount !== '0'
  )
    sessionFail(SESSION_CODES.BINDING);
  voucherFor(value.voucher);
  return value;
}
export function parseRecord(
  value: unknown,
  terms: PaymentSessionTerms,
): BatchRecord {
  const row = controlObject(value, [
    'version',
    'terms',
    'channelId',
    'state',
    'hints',
    'salt',
    'opening',
    'cumulativeAtomic',
    'voucher',
    'requests',
    'lastActivity',
    'closing',
    'settlement',
    'pending',
  ]);
  if (
    row.version !== PAYMENT_SESSION.version ||
    canonicalJson(termsFor(row.terms)) !== canonicalJson(terms) ||
    !Object.values(SESSION_STATES).some((state) => state === row.state)
  )
    sessionFail(SESSION_CODES.BINDING);
  const parsed = parseRequests(row.requests);
  // These SDK values are revalidated against signatures/terms when used, never used to infer success.
  const state = Object.values(SESSION_STATES).find(
    (state) => state === row.state,
  );
  if (!state) sessionFail();
  if (typeof row.channelId !== 'string') sessionFail();
  const channelId = row.channelId === '' ? '' : controlAddress(row.channelId);
  const cumulativeAtomic = atomic(row.cumulativeAtomic);
  if (BigInt(String(row.cumulativeAtomic)) > BigInt(terms.depositAtomic))
    sessionFail();
  const lastActivity = controlInteger(row.lastActivity, 0);
  const opening = row.opening === null ? null : openingFor(row.opening, terms);
  const voucher = row.voucher === null ? null : voucherFor(row.voucher);
  const hints = parseHints(row.hints);
  const salt = atomic(row.salt);
  if (
    !row.pending ||
    typeof row.pending !== 'object' ||
    Array.isArray(row.pending) ||
    Object.values(row.pending).some((entry) => typeof entry !== 'string')
  )
    sessionFail();
  const pending: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.pending)) {
    if (typeof value !== 'string') sessionFail();
    pending[key] = value;
  }
  const closing = parseClosing(row.closing);
  const settlement = parseSettlement(row.settlement);
  const record: BatchRecord = {
    version: PAYMENT_SESSION.version,
    terms,
    channelId,
    state,
    hints,
    salt,
    opening,
    cumulativeAtomic,
    voucher,
    requests: parsed,
    lastActivity,
    closing,
    settlement,
    pending,
  };
  coherentRecord(record);
  return record;
}

function parseRequests(requests: unknown): BatchRecord['requests'] {
  if (
    !requests ||
    typeof requests !== 'object' ||
    Array.isArray(requests) ||
    Object.keys(requests).length > BATCH_SESSION_DEFAULTS.maxRequests
  )
    sessionFail();
  const parsed: BatchRecord['requests'] = {};
  for (const [key, raw] of Object.entries(requests)) {
    const request = controlObject(raw, [
      'requestId',
      'requestDigest',
      'maxAtomic',
      'bill',
      'accepted',
    ]);
    const checked = requestFor({
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      maxAtomic: request.maxAtomic,
    });
    if (key !== checked.requestId || typeof request.accepted !== 'boolean')
      sessionFail();
    parsed[key] = {
      ...checked,
      bill: request.bill === null ? null : billFor(request.bill),
      accepted: request.accepted,
    };
  }

  return parsed;
}

function parseHints(value: unknown): BatchRecord['hints'] {
  let hints: BatchRecord['hints'] = null;
  if (value !== null) {
    const hint = controlObject(value, [
      'blockhash',
      'lastValidBlockHeight',
      'slot',
    ]);
    hints = {
      blockhash: controlAddress(hint.blockhash),
      lastValidBlockHeight: atomic(hint.lastValidBlockHeight),
      slot: atomic(hint.slot),
    };
  }

  return hints;
}

function parseClosing(value: unknown): BatchRecord['closing'] {
  let closing: BatchRecord['closing'] = null;
  if (value !== null) {
    if (
      !isBatchFacilitatorPayload(value) ||
      (value.type !== 'refund' && value.type !== 'seal')
    )
      sessionFail();
    closing = value;
  }

  return closing;
}

function parseSettlement(value: unknown): BatchRecord['settlement'] {
  let settlement: BatchRecord['settlement'] = null;
  if (value !== null) {
    const settled = controlObject(value, [
      'channelId',
      'chargedAtomic',
      'refundedAtomic',
      'transaction',
    ]);
    if (typeof settled.transaction !== 'string' || !settled.transaction)
      sessionFail();
    settlement = {
      channelId: controlAddress(settled.channelId),
      chargedAtomic: atomic(settled.chargedAtomic),
      refundedAtomic: atomic(settled.refundedAtomic),
      transaction: settled.transaction,
    };
  }

  return settlement;
}
