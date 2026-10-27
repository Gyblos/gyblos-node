// Pure arithmetic for the wallet preview; these numbers never represent funds or authorizations.
// It is intentionally independent of payment SDKs, signing and product metering policy.
import { DEMO_ACCOUNT, DEMO_AUTH } from './constants.js';

export type DemoAuthorizationStatus =
  (typeof DEMO_AUTH)[keyof typeof DEMO_AUTH];
export function chatAuthorizationNotice(
  status: DemoAuthorizationStatus,
): string {
  switch (status) {
    case DEMO_AUTH.BALANCE:
      return 'Insufficient balance for this model. Choose a free model to continue. Your draft is kept.';
    case DEMO_AUTH.LIMIT:
      return 'The daily spending limit is reached. Choose a free model to continue. Your draft is kept.';
    case DEMO_AUTH.OFFLINE:
      return 'Connection paused. Resume the connection to send. Your draft is kept.';
    case DEMO_AUTH.APPROVED:
      return '';
  }
}

export interface DemoAccount {
  credits: number;
  spent: number;
  budget: number;
}
export function authorizeDemo(
  account: DemoAccount,
  free: boolean,
  online: boolean,
) {
  if (!online) return { status: DEMO_AUTH.OFFLINE, ...account };
  if (free) return { status: DEMO_AUTH.APPROVED, ...account };
  const cost = DEMO_ACCOUNT.REQUEST_COST;
  const nextSpent =
    Math.round((account.spent + cost) * DEMO_ACCOUNT.UNITS_PER_CREDIT) /
    DEMO_ACCOUNT.UNITS_PER_CREDIT;
  if (account.credits < cost) return { status: DEMO_AUTH.BALANCE, ...account };
  if (nextSpent > account.budget)
    return { status: DEMO_AUTH.LIMIT, ...account };
  return {
    status: DEMO_AUTH.APPROVED,
    ...account,
    credits:
      Math.round((account.credits - cost) * DEMO_ACCOUNT.UNITS_PER_CREDIT) /
      DEMO_ACCOUNT.UNITS_PER_CREDIT,
    spent: nextSpent,
  };
}
export { DEMO_ACCOUNT, DEMO_AUTH } from './constants.js';
