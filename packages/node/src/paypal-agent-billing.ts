// Applies the bounded sandbox agent's completed-inference billing policy.
// It does not call PayPal or retain inference content.
import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_SESSION_RECORD_VERSION,
  PAYPAL_SESSION_PHASE as PHASE,
} from './constants';
import type { PaypalSessionRecord } from './paypal-session-record';

function fail(
  code: (typeof PAYPAL_ERROR_CODES)[keyof typeof PAYPAL_ERROR_CODES],
): never {
  throw new PaypalError(code);
}
export type AgentOperation = {
  idempotencyDigest?: string;
  equivalentDigests?: readonly string[];
};
type CurrentRecord = Extract<
  PaypalSessionRecord,
  { version: typeof PAYPAL_SESSION_RECORD_VERSION }
>;
export function checkAgentOperation(
  record: PaypalSessionRecord,
  digest: string,
  agent: AgentOperation,
) {
  if (record.version !== PAYPAL_SESSION_RECORD_VERSION)
    return fail(PAYPAL_ERROR_CODES.INVALID_CONFIG);
  if (
    record.agentCompletions.some((completed) =>
      agent.idempotencyDigest === undefined
        ? completed.requestDigest === digest ||
          agent.equivalentDigests?.includes(completed.requestDigest)
        : completed.idempotencyDigest === agent.idempotencyDigest,
    )
  )
    return fail(PAYPAL_ERROR_CODES.DUPLICATE_REQUEST);
}
export function completedAgentRecord(
  record: CurrentRecord,
  attemptIds: string[],
  messageId: string,
  digest: string,
  agent: AgentOperation,
): CurrentRecord {
  return {
    ...record,
    phase: PHASE.ACTIVE,
    attemptIds,
    spentCents: record.spentCents + PAYPAL_SANDBOX.messageCents,
    agentCompletions: [
      ...record.agentCompletions,
      {
        messageId,
        requestDigest: digest,
        ...(agent.idempotencyDigest
          ? { idempotencyDigest: agent.idempotencyDigest }
          : {}),
      },
    ],
  };
}
