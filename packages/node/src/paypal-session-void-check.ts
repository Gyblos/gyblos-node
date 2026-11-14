// Checks one interrupted sandbox void without changing payment or journal state.
import { canonicalJson } from '@gyblos/protocol';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  parsePaypalSessionState,
  type PaypalSessionRecord,
} from './paypal-session-record';
import type { PaypalSessionDependencies } from './paypal-session-support';

export function fail(
  code: (typeof PAYPAL_ERROR_CODES)[keyof typeof PAYPAL_ERROR_CODES],
): never {
  throw new PaypalError(code);
}

export async function checkVoid(
  record: PaypalSessionRecord,
  deps: PaypalSessionDependencies,
  exclusive: boolean,
  setBusy: (busy: boolean) => void,
) {
  const check = deps.payment.checkVoidedAuthorization?.bind(deps.payment);
  if (!exclusive || !check || !record.orderId || !record.authorizationId)
    throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
  setBusy(true);
  try {
    const expected = canonicalJson(record);
    const before = parsePaypalSessionState(await deps.journal.read());
    if (before.legacyBlocked || canonicalJson(before.record) !== expected)
      throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
    await check(
      record.orderId,
      record.requestId,
      record.authorizationId,
      record.limitCents,
    );
    const after = parsePaypalSessionState(await deps.journal.read());
    if (after.legacyBlocked || canonicalJson(after.record) !== expected)
      throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
  } finally {
    setBusy(false);
  }
}
