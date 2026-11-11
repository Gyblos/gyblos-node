// Parses owner-selected API budgets in cents; it starts no services or payment operations.
import {
  PAYPAL_SANDBOX,
  PAYPAL_SANDBOX_LIMIT_OPTIONS,
} from '@gyblos/config/constants';

import { PAYPAL_AGENT_USAGE_STATE } from './constants';

const maximum = Math.max(...PAYPAL_SANDBOX_LIMIT_OPTIONS);
export function validPaypalAgentSpendLimit(
  value: unknown,
  available = maximum,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= PAYPAL_SANDBOX.messageCents &&
    value <= available &&
    value <= maximum &&
    value % PAYPAL_SANDBOX.messageCents === 0
  );
}
export function paypalAgentLimitCents(draft: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(draft)) return null;
  const [whole = '', fraction = ''] = draft.split('.');
  const cents =
    Number(whole) * PAYPAL_SANDBOX.centsPerDollar +
    Number(fraction.padEnd(2, '0'));
  return validPaypalAgentSpendLimit(cents) ? cents : null;
}

export function parsePaypalAgentBudget(row: Record<string, unknown>) {
  const keyLimit = row.keyLimitCents;
  const keySpent = row.keySpentCents;
  const sessionLimit = row.limitCents;
  const sessionSpent = row.spentCents;
  if (
    (row.usageState === PAYPAL_AGENT_USAGE_STATE.AVAILABLE &&
      keySpent === keyLimit) ||
    typeof sessionLimit !== 'number' ||
    typeof sessionSpent !== 'number' ||
    !validPaypalAgentSpendLimit(keyLimit, sessionLimit) ||
    typeof keySpent !== 'number' ||
    !Number.isSafeInteger(keySpent) ||
    keySpent < 0 ||
    keySpent > keyLimit ||
    keySpent > sessionSpent ||
    keySpent % PAYPAL_SANDBOX.messageCents !== 0
  )
    return null;
  return { keyLimitCents: keyLimit, keySpentCents: keySpent };
}
