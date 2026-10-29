// Harness shape and shared helpers for the payment port contract (payment-contract*.ts).
// Balances are in the payment asset's atomic units; rent and fees paid in SOL are out of scope.
import assert from 'node:assert/strict';

import type { PaymentErrorCode } from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentDescription,
  type PaymentServer,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

import { assertPrivate, UPSTREAM_MARKER } from './private-error';

export const CONTRACT_CEILING = 1_000_000n;
export const CONTRACT_PARTIAL = 250_000n;
export const CONTRACT_NOW = 1_800_000_000_000;

export const PAYMENT_EVENTS = {
  JOURNAL: 'journal',
  SIGN: 'sign',
  DEPOSIT: 'deposit',
  SETTLE: 'settle',
} as const;
export type PaymentEvent = (typeof PAYMENT_EVENTS)[keyof typeof PAYMENT_EVENTS];

export interface PaymentBalances {
  payer: bigint;
  payee: bigint;
  escrow: bigint;
}

export interface PaymentRig {
  client: PaymentClient;
  server: PaymentServer;
  // Another seller on the same ledger whose description differs from `server` by `overrides`.
  serverWith(overrides: Partial<PaymentDescription>): PaymentServer;
  // A valid signature over `terms` by a payer key that is not `terms.buyer` (a malicious buyer).
  foreignAuthorization(terms: PaymentTerms): Promise<PaymentAuthorization>;
  // Valid terms for `server` at CONTRACT_NOW, under the buyer's ceiling; overrides make them hostile.
  terms(overrides?: Partial<PaymentTerms>): Promise<PaymentTerms>;
  observe(): { events: readonly PaymentEvent[]; balances: PaymentBalances };
  close(): Promise<void>;
}

export interface PaymentRigOptions {
  failJournal: boolean;
  // The server's chain or facilitator calls throw upstream text that contains UPSTREAM_MARKER.
  failUpstream: boolean;
}

export interface PaymentHarness {
  // The clock reads CONTRACT_NOW; the buyer's ceiling is CONTRACT_CEILING. Configuration that could
  // be secret (RPC URLs, keys) must contain UPSTREAM_MARKER so the contract can prove it never leaks.
  start(options: PaymentRigOptions): Promise<PaymentRig>;
}

export async function rejectsWith(
  run: Promise<unknown>,
  code: PaymentErrorCode,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof PaymentError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assertPrivate(error);
    return true;
  });
}

// Successful results travel to peers and logs; they must not carry secret configuration either.
export function assertPublic(value: unknown): void {
  assert.doesNotMatch(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? String(item) : item,
    ),
    new RegExp(UPSTREAM_MARKER),
  );
}

export async function withRig(
  harness: PaymentHarness,
  run: (rig: PaymentRig) => Promise<void>,
  options: Partial<PaymentRigOptions> = {},
): Promise<void> {
  const rig = await harness.start({
    failJournal: false,
    failUpstream: false,
    ...options,
  });
  try {
    await run(rig);
  } finally {
    await rig.close();
  }
}

export function count(rig: PaymentRig, event: PaymentEvent): number {
  return rig.observe().events.filter((entry) => entry === event).length;
}

export function delta(before: PaymentBalances, after: PaymentBalances) {
  return {
    payer: after.payer - before.payer,
    payee: after.payee - before.payee,
    escrow: after.escrow - before.escrow,
  };
}

export async function admitted(rig: PaymentRig) {
  const terms = await rig.terms();
  const authorization = await rig.client.authorize(terms);
  return {
    terms,
    authorization,
    admission: await rig.server.admit(authorization, terms),
  };
}

export function otherDigest(digest: string): string {
  return `${digest.startsWith('0') ? '1' : '0'}${digest.slice(1)}`;
}
