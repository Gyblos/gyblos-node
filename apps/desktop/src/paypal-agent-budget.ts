// Bounds an ephemeral local API key using the existing session's agent ledger.
// It never stores credentials, reserves funds or changes payment records.
import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import { validPaypalAgentSpendLimit } from './paypal-agent-limit';

type State = {
  scope: string | undefined;
  activity: { id: string; agentCents: number } | null;
  phase: unknown;
  expired: boolean;
  remainingAttempts: number;
  spentCents: number;
  limitCents: number;
};
export function createPaypalAgentBudget(read: () => State, selected?: number) {
  const initial = read();
  const limit = selected ?? initial.limitCents - initial.spentCents;
  if (
    !initial.scope ||
    !initial.activity ||
    initial.phase !== PAYPAL_SESSION_PHASE.ACTIVE ||
    initial.expired ||
    initial.remainingAttempts === 0 ||
    !validPaypalAgentSpendLimit(limit, initial.limitCents - initial.spentCents)
  )
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_REQUEST);
  const scope = initial.scope;
  const id = initial.activity.id;
  const baseline = initial.activity.agentCents;
  function status() {
    const current = read();
    const recorded = current.activity?.agentCents;
    if (
      current.scope !== scope ||
      current.activity?.id !== id ||
      typeof recorded !== 'number' ||
      !Number.isSafeInteger(recorded) ||
      recorded < baseline ||
      recorded - baseline > limit
    )
      throw new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION);
    return { keyLimitCents: limit, keySpentCents: recorded - baseline };
  }
  return {
    status,
    authorize() {
      const usage = status();
      if (
        usage.keySpentCents + PAYPAL_SANDBOX.messageCents >
        usage.keyLimitCents
      )
        throw new PaypalError(PAYPAL_ERROR_CODES.KEY_LIMIT_REACHED);
    },
  };
}
