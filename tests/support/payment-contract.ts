// Shared payment port contract: every PaymentClient/PaymentServer pair must keep these money rules.
// Harnesses use synthetic ledgers or devnet doubles; no test here moves real funds.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentServer,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

import { assertPrivate } from './engine-contract';

export const CONTRACT_CEILING = 1_000_000n;
export const CONTRACT_NOW = 1_800_000_000_000;

export type PaymentEvent = 'journal' | 'sign' | 'deposit' | 'settle';

export interface PaymentObservation {
  events: readonly PaymentEvent[];
  balances: { payer: bigint; payee: bigint; escrow: bigint };
}

export interface PaymentRig {
  client: PaymentClient;
  server: PaymentServer;
  // Valid terms for this rig at CONTRACT_NOW, under the buyer's ceiling; overrides make them hostile.
  terms(overrides?: Partial<PaymentTerms>): PaymentTerms;
  observe(): PaymentObservation;
  close(): Promise<void>;
}

export interface PaymentHarness {
  // The clock reads CONTRACT_NOW; the buyer's ceiling is CONTRACT_CEILING. Configuration that could
  // be secret (RPC URLs, keys) must contain `secret` so the contract can prove it never leaks.
  start(options: { failJournal: boolean; secret: string }): Promise<PaymentRig>;
}

const SECRET = 'UPSTREAM-SECRET-MARKER';
const PARTIAL = 250_000n;

async function rejectsWith(
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

async function withRig(
  harness: PaymentHarness,
  run: (rig: PaymentRig) => Promise<void>,
  failJournal = false,
): Promise<void> {
  const rig = await harness.start({ failJournal, secret: SECRET });
  try {
    await run(rig);
  } finally {
    await rig.close();
  }
}

function count(rig: PaymentRig, event: PaymentEvent): number {
  return rig.observe().events.filter((entry) => entry === event).length;
}

async function admitted(rig: PaymentRig) {
  const terms = rig.terms();
  const authorization = await rig.client.authorize(terms);
  return {
    terms,
    authorization,
    admission: await rig.server.admit(authorization, terms),
  };
}

function hostileTerms(rig: PaymentRig): Partial<PaymentTerms>[] {
  const valid = rig.terms();
  return [
    { network: 'solana:other' },
    { mint: rig.terms({}).payTo },
    { buyer: valid.payTo },
    { maxAtomic: String(CONTRACT_CEILING + 1n) },
    { maxAtomic: '-1' },
    { maxAtomic: '01' },
    { maxAtomic: 'one' },
    { requestDigest: 'not-a-digest' },
    { expiresAt: CONTRACT_NOW },
  ];
}

function clientContract(name: string, harness: PaymentHarness): void {
  void test(`${name}: untrusted terms are rejected before any journal or signature`, async () =>
    withRig(harness, async (rig) => {
      for (const overrides of hostileTerms(rig))
        await rejectsWith(
          rig.client.authorize(rig.terms(overrides)),
          PAYMENT_ERROR_CODES.UNTRUSTED_TERMS,
        );
      assert.deepEqual(rig.observe().events, []);
    }));

  void test(`${name}: the journal is written before the only signature`, async () =>
    withRig(harness, async (rig) => {
      const authorization = await rig.client.authorize(rig.terms());
      assert.deepEqual(rig.observe().events.slice(0, 2), ['journal', 'sign']);
      assert.equal(count(rig, 'sign'), 1);
      assert.equal(authorization.requestDigest, rig.terms().requestDigest);
      assert.equal(authorization.maxAtomic, rig.terms().maxAtomic);
    }));

  void test(`${name}: an unavailable journal prevents signing`, async () =>
    withRig(
      harness,
      async (rig) => {
        await rejectsWith(
          rig.client.authorize(rig.terms()),
          PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
        );
        assert.equal(count(rig, 'sign'), 0);
      },
      true,
    ));

  void test(`${name}: a lost authorization is never signed again and stays open for reconciliation`, async () =>
    withRig(harness, async (rig) => {
      const terms = rig.terms();
      const lost = await rig.client.authorize(terms);
      await rejectsWith(
        rig.client.authorize(terms),
        PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED,
      );
      assert.equal(count(rig, 'sign'), 1);
      assert.deepEqual(await rig.client.reconcile(), [
        {
          channelId: lost.channelId,
          requestDigest: terms.requestDigest,
          state: PAYMENT_CHANNEL_STATES.OPEN,
          chargedAtomic: null,
        },
      ]);
    }));
}

function otherDigest(digest: string): string {
  return `${digest.startsWith('0') ? '1' : '0'}${digest.slice(1)}`;
}

function tamper(
  authorization: PaymentAuthorization,
  rig: PaymentRig,
): PaymentAuthorization[] {
  return [
    { ...authorization, payer: rig.terms().payTo },
    { ...authorization, maxAtomic: String(CONTRACT_CEILING - 1n) },
    {
      ...authorization,
      requestDigest: otherDigest(authorization.requestDigest),
    },
    { ...authorization, payload: `${authorization.payload}x` },
  ];
}

function admissionContract(name: string, harness: PaymentHarness): void {
  void test(`${name}: admission rejects any mismatch without moving funds`, async () =>
    withRig(harness, async (rig) => {
      const terms = rig.terms();
      const authorization = await rig.client.authorize(terms);
      const before = rig.observe().balances;
      for (const forged of tamper(authorization, rig))
        await rejectsWith(
          rig.server.admit(forged, terms),
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        );
      for (const other of [
        rig.terms({ maxAtomic: String(CONTRACT_CEILING - 1n) }),
        rig.terms({ payTo: terms.buyer }),
        rig.terms({ requestDigest: otherDigest(terms.requestDigest) }),
      ])
        await rejectsWith(
          rig.server.admit(authorization, other),
          PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
        );
      assert.deepEqual(rig.observe().balances, before);
      assert.equal(count(rig, 'deposit'), 0);
    }));

  void test(`${name}: expired terms are not admitted`, async () =>
    withRig(harness, async (rig) => {
      const terms = rig.terms({ expiresAt: CONTRACT_NOW + 1 });
      const authorization = await rig.client.authorize(terms);
      await rejectsWith(
        rig.server.admit(authorization, { ...terms, expiresAt: CONTRACT_NOW }),
        PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
      );
      assert.equal(count(rig, 'deposit'), 0);
    }));

  void test(`${name}: a channel is admitted once and deposits exactly the ceiling`, async () =>
    withRig(harness, async (rig) => {
      const before = rig.observe().balances;
      const { terms, authorization, admission } = await admitted(rig);
      assert.equal(admission.channelId, authorization.channelId);
      assert.equal(admission.maxAtomic, terms.maxAtomic);
      const after = rig.observe().balances;
      assert.equal(after.escrow, CONTRACT_CEILING);
      assert.equal(before.payer - after.payer, CONTRACT_CEILING);
      await rejectsWith(
        rig.server.admit(authorization, terms),
        PAYMENT_ERROR_CODES.CHANNEL_REUSED,
      );
      assert.equal(count(rig, 'deposit'), 1);
    }));
}

function settlementContract(name: string, harness: PaymentHarness): void {
  for (const charged of [0n, PARTIAL, CONTRACT_CEILING])
    void test(`${name}: settling ${charged} charges it and refunds the rest`, async () =>
      withRig(harness, async (rig) => {
        const before = rig.observe().balances;
        const { authorization, admission } = await admitted(rig);
        const settlement = await rig.server.settle(admission, String(charged));
        assert.equal(settlement.channelId, admission.channelId);
        assert.equal(settlement.chargedAtomic, String(charged));
        assert.equal(
          BigInt(settlement.chargedAtomic) + BigInt(settlement.refundedAtomic),
          CONTRACT_CEILING,
        );
        const after = rig.observe().balances;
        assert.equal(after.escrow, 0n);
        assert.equal(after.payee - before.payee, charged);
        assert.equal(before.payer - after.payer, charged);
        await rig.client.checkReceipt(
          authorization,
          settlement,
          String(charged),
        );
        assert.deepEqual(await rig.client.reconcile(), [
          {
            channelId: authorization.channelId,
            requestDigest: authorization.requestDigest,
            state: PAYMENT_CHANNEL_STATES.SETTLED,
            chargedAtomic: String(charged),
          },
        ]);
      }));

  void test(`${name}: invalid charges and second settlements never move funds`, async () =>
    withRig(harness, async (rig) => {
      const { admission } = await admitted(rig);
      const before = rig.observe().balances;
      for (const charged of [String(CONTRACT_CEILING + 1n), '-1', '1.5', ''])
        await rejectsWith(
          rig.server.settle(admission, charged),
          PAYMENT_ERROR_CODES.INVALID_CHARGE,
        );
      assert.deepEqual(rig.observe().balances, before);
      await rig.server.settle(admission, String(PARTIAL));
      const settled = rig.observe().balances;
      await rejectsWith(
        rig.server.settle(admission, String(PARTIAL)),
        PAYMENT_ERROR_CODES.ALREADY_SETTLED,
      );
      assert.deepEqual(rig.observe().balances, settled);
      assert.equal(count(rig, 'settle'), 1);
    }));

  void test(`${name}: the buyer rejects a settlement that differs from its own metering`, async () =>
    withRig(harness, async (rig) => {
      const { authorization, admission } = await admitted(rig);
      const settlement = await rig.server.settle(admission, String(PARTIAL));
      for (const [received, expected] of [
        [settlement, String(PARTIAL - 1n)],
        [{ ...settlement, refundedAtomic: '0' }, String(PARTIAL)],
        [
          { ...settlement, channelId: `${settlement.channelId}x` },
          String(PARTIAL),
        ],
      ] as const)
        await rejectsWith(
          rig.client.checkReceipt(authorization, received, expected),
          PAYMENT_ERROR_CODES.RECEIPT_MISMATCH,
        );
      assert.equal(
        (await rig.client.reconcile())[0]?.state,
        PAYMENT_CHANNEL_STATES.OPEN,
      );
    }));
}

// Registers the whole contract for one PaymentClient/PaymentServer pair.
export function paymentContract(name: string, harness: PaymentHarness): void {
  clientContract(name, harness);
  admissionContract(name, harness);
  settlementContract(name, harness);
}
