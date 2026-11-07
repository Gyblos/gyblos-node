// Payment labels distinguish the selected method from wallet balances.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canSelectPreviewModel,
  canSwitchPaymentMethod,
  PAYMENT_METHOD,
  paymentMethodLabel,
  paypalActivityLabel,
  paypalAmountsAvailable,
  paypalFinishDialog,
  paypalHasUnfinishedSession,
  paypalNewSessionTerms,
  paypalPaymentSummary,
  paypalStatusVisible,
  paypalUsageSummary,
  shouldMonitorPaypal,
} from '@gyblos/desktop/paypal-model';
import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';

const activeSession = {
  phase: PAYPAL_SESSION_PHASE.ACTIVE,
  expired: false,
  remainingAttempts: 10,
  spentCents: 30,
  limitCents: 500,
  messageCents: 10,
};

void test('the overview retains a restored session rate and hides it while unchecked', () => {
  const restored = { ...activeSession, messageCents: 50 };
  assert.equal(paypalPaymentSummary(restored, true, false).rateCents, 50);
  assert.equal(paypalPaymentSummary(restored, false, false).rateCents, null);
  assert.equal(paypalPaymentSummary(restored, true, true).rateCents, null);
});

void test('the payment overview shows recorded usage and available authorization separately', () => {
  const summary = paypalPaymentSummary(activeSession, true, false);
  assert.equal(summary.usedCents, 30);
  assert.equal(summary.limitCents, 500);
  assert.equal(summary.remainingCents, 470);
  assert.equal(summary.capturedCents, null);
});

void test('only confirmed completed sessions show a captured amount', () => {
  const summary = paypalPaymentSummary(
    { ...activeSession, phase: PAYPAL_SESSION_PHASE.COMPLETED },
    true,
    false,
  );
  assert.equal(summary.capturedCents, 30);
  assert.equal(summary.remainingCents, null);
  assert.equal(summary.label, 'Payment captured');
  for (const phase of [
    PAYPAL_SESSION_PHASE.REVIEW,
    PAYPAL_SESSION_PHASE.VOIDED,
    PAYPAL_SESSION_PHASE.EXECUTING,
    PAYPAL_SESSION_PHASE.CAPTURING,
  ]) {
    const pending = paypalPaymentSummary(
      { ...activeSession, phase },
      true,
      false,
    );
    assert.equal(pending.usedCents, 30);
    assert.equal(pending.capturedCents, null);
    assert.equal(pending.remainingCents, null);
  }
});

void test('stale or busy sessions never advertise old amounts as current', () => {
  for (const { fresh, busy } of [
    { fresh: false, busy: false },
    { fresh: true, busy: true },
  ]) {
    const summary = paypalPaymentSummary(activeSession, fresh, busy);
    assert.equal(summary.usedCents, null);
    assert.equal(summary.limitCents, null);
    assert.equal(summary.remainingCents, null);
    assert.equal(summary.capturedCents, null);
  }
});

void test('expired, exhausted and blocked sessions do not advertise spendable authorization', () => {
  assert.equal(
    paypalPaymentSummary({ ...activeSession, expired: true }, true, false)
      .remainingCents,
    null,
  );
  assert.equal(
    paypalPaymentSummary(
      { ...activeSession, remainingAttempts: 0 },
      true,
      false,
    ).remainingCents,
    null,
  );
  assert.equal(
    paypalPaymentSummary(
      { ...activeSession, phase: PAYPAL_SESSION_STATUS.BLOCKED },
      true,
      false,
    ).usedCents,
    null,
  );
  assert.equal(paypalPaymentSummary(null, true, false).limitCents, null);
});

void test('session usage distinguishes the recorded amount from the authorized limit', () => {
  assert.equal(paypalUsageSummary(30, 100), 'USD 0.30 used of USD 1.00');
  assert.equal(paypalUsageSummary(0, 500), 'USD 0.00 used of USD 5.00');
});

void test('new sandbox terms appear only when a fresh new session is available', () => {
  const ready = { phase: 'ready' as const, limitCents: 100, messageCents: 10 };
  assert.deepEqual(paypalNewSessionTerms(ready, true), {
    limitCents: 100,
    messageCents: 10,
  });
  assert.equal(paypalNewSessionTerms(ready, false), null);
  assert.equal(paypalNewSessionTerms(null, true), null);
  assert.equal(
    paypalNewSessionTerms({ ...ready, phase: 'active' }, true),
    null,
  );
  for (const phase of ['completed', 'voided', 'cancelled'] as const)
    assert.deepEqual(
      paypalNewSessionTerms({ phase, limitCents: 200, messageCents: 50 }, true),
      { limitCents: 100, messageCents: 10 },
    );
});

void test('the selected payment method is identified without inventing a balance', () => {
  assert.equal(paymentMethodLabel(PAYMENT_METHOD.USDC), 'USDC preview');
  assert.equal(paymentMethodLabel(PAYMENT_METHOD.PAYPAL), 'PayPal Sandbox');
});

void test('an in-flight or unacknowledged PayPal reply cannot be hidden by switching methods', () => {
  assert.equal(
    canSwitchPaymentMethod(PAYMENT_METHOD.PAYPAL, PAYMENT_METHOD.USDC, true),
    false,
  );
  assert.equal(
    canSwitchPaymentMethod(PAYMENT_METHOD.PAYPAL, PAYMENT_METHOD.USDC, false),
    true,
  );
  assert.equal(
    canSwitchPaymentMethod(PAYMENT_METHOD.USDC, PAYMENT_METHOD.PAYPAL, true),
    true,
  );
});

void test('preview responses lock actual method changes in either direction', () => {
  for (const current of [PAYMENT_METHOD.USDC, PAYMENT_METHOD.PAYPAL]) {
    const next =
      current === PAYMENT_METHOD.USDC
        ? PAYMENT_METHOD.PAYPAL
        : PAYMENT_METHOD.USDC;
    assert.equal(canSwitchPaymentMethod(current, next, false, true), false);
    assert.equal(canSwitchPaymentMethod(current, next, false, false), true);
    assert.equal(canSwitchPaymentMethod(current, current, false, true), true);
  }
});

void test('USDC screens do not start or present an unchecked PayPal session', () => {
  assert.equal(shouldMonitorPaypal(PAYMENT_METHOD.USDC, true), false);
  assert.equal(shouldMonitorPaypal(PAYMENT_METHOD.PAYPAL, false), false);
  assert.equal(shouldMonitorPaypal(PAYMENT_METHOD.PAYPAL, true), true);
  assert.equal(paypalStatusVisible(PAYMENT_METHOD.USDC, true), false);
  assert.equal(paypalStatusVisible(PAYMENT_METHOD.PAYPAL, false), false);
  assert.equal(paypalStatusVisible(PAYMENT_METHOD.PAYPAL, true), true);
});

void test('unknown and blocked sessions do not present default amounts as recorded usage', () => {
  assert.equal(paypalAmountsAvailable(null), false);
  assert.equal(
    paypalAmountsAvailable({ phase: PAYPAL_SESSION_STATUS.BLOCKED }),
    false,
  );
  assert.equal(paypalAmountsAvailable({ phase: 'ready' }), false);
  assert.equal(paypalAmountsAvailable({ phase: 'active' }), true);
  assert.equal(paypalAmountsAvailable({ phase: 'review' }), true);
});

void test('an unfinished PayPal session remains identifiable after switching methods', () => {
  assert.equal(paypalHasUnfinishedSession(null), false);
  assert.equal(paypalHasUnfinishedSession({ phase: 'active' }), true);
  assert.equal(paypalHasUnfinishedSession({ phase: 'review' }), true);
  assert.equal(
    paypalHasUnfinishedSession({ phase: PAYPAL_SESSION_PHASE.COMPLETED }),
    false,
  );
  assert.equal(paypalHasUnfinishedSession({ phase: 'voided' }), false);
});

void test('activity labels distinguish recorded usage from confirmed settlement', () => {
  assert.equal(paypalActivityLabel(null), 'Status unavailable');
  assert.equal(
    paypalActivityLabel({ phase: 'active', expired: false }),
    'Session active',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'active', expired: true }),
    'Session expired',
  );
  assert.equal(
    paypalActivityLabel({
      phase: PAYPAL_SESSION_PHASE.COMPLETED,
      expired: false,
    }),
    'Payment captured',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'review', expired: false }),
    'Needs review',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'capturing', expired: false }),
    'Payment closure needs review',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'voiding', expired: false }),
    'Authorization closure needs review',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'created', expired: false }),
    'Approval not confirmed',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'authorizing', expired: false }),
    'Preparing or needs review',
  );
  assert.equal(
    paypalActivityLabel({ phase: 'cancelled', expired: false }),
    'Checkout abandoned locally',
  );
});

void test('settlement confirmation names the test amount and distinguishes an unused authorization', () => {
  const capture = paypalFinishDialog({ spentCents: 30, limitCents: 100 });
  assert.match(capture.detail ?? '', /USD 0\.30/);
  assert.match(capture.detail ?? '', /test funds/i);
  assert.equal(capture.defaultId, 0);
  assert.equal(capture.cancelId, 0);
  const unused = paypalFinishDialog({ spentCents: 0, limitCents: 100 });
  assert.match(unused.detail ?? '', /void/i);
  assert.doesNotMatch(unused.detail ?? '', /capture/i);
});

void test('sandbox does not present preview catalog models as selectable', () => {
  assert.equal(canSelectPreviewModel(PAYMENT_METHOD.USDC), true);
  assert.equal(canSelectPreviewModel(PAYMENT_METHOD.PAYPAL), false);
});
