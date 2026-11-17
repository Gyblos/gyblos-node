// Synthetic PayPal sessions and references only; never connects to a service or reads real payments.
import {
  parsePaypalAgentResult,
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_USAGE_STATE,
} from '@gyblos/desktop/paypal-agent-model';
import { parsePaypalResult, PAYPAL_ACTION } from '@gyblos/desktop/paypal-model';
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';

import { PREVIEW } from './constants';
import { requestObject as read } from './input';

export function createPaypalPreview(
  ready: boolean,
  answer: string,
  now: number,
) {
  const paypalId = 'a'.repeat(PREVIEW.paymentIdCharacters);
  let paypalPhase: (typeof PAYPAL_SESSION_PHASE)[keyof typeof PAYPAL_SESSION_PHASE] =
    PAYPAL_SESSION_PHASE.ACTIVE;
  let paypalUsed: number = PREVIEW.recordedCents;
  let paypalLimit: number = PREVIEW.sessionLimitCents;
  let paypalAgent = ready;
  let pending: { messageId: string; text: string } | null = null;
  function paypalState() {
    return parsePaypalResult({
      sessionId: paypalId,
      status: {
        phase: paypalPhase,
        limitCents: paypalLimit,
        spentCents: paypalUsed,
        messageCents: 10,
        expired: false,
        remainingAttempts: Math.floor(
          (paypalLimit - paypalUsed) / PREVIEW.replyCents,
        ),
        approvalLinkAvailable: paypalPhase === PAYPAL_SESSION_PHASE.CREATED,
      },
      model: 'qwen3:0.6b',
      answer: pending,
      error: null,
    });
  }
  const desktopPaypal = {
    run: async (input: unknown) => {
      const request = read(input);
      if (request.action === PAYPAL_ACTION.CREATE) {
        paypalPhase = PAYPAL_SESSION_PHASE.CREATED;
        paypalUsed = 0;
        if (typeof request.limitCents === 'number')
          paypalLimit = request.limitCents;
      }
      if (
        [PAYPAL_ACTION.APPROVE, PAYPAL_ACTION.COMPLETE_RETURN].some(
          (value) => value === request.action,
        )
      )
        paypalPhase = PAYPAL_SESSION_PHASE.ACTIVE;
      if (request.action === PAYPAL_ACTION.FINISH)
        paypalPhase = PAYPAL_SESSION_PHASE.COMPLETED;
      if (request.action === PAYPAL_ACTION.SEND) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, PREVIEW.replyDelayMs),
        );
        pending = { messageId: 'PREVIEWREPLY00001', text: answer };
      }
      if (request.action === PAYPAL_ACTION.ACKNOWLEDGE && pending) {
        paypalUsed += PREVIEW.replyCents;
        pending = null;
      }
      return paypalState();
    },
    onReturn: () => () => {},
    onCancel: () => () => {},
  };
  const desktopPaypalAgent = {
    run: async (input: unknown) => {
      const request = read(input);
      if (request.action === PAYPAL_AGENT_ACTION.CONNECT) paypalAgent = true;
      if (request.action === PAYPAL_AGENT_ACTION.DISCONNECT)
        paypalAgent = false;
      return parsePaypalAgentResult({
        connection: paypalAgent
          ? {
              url: 'http://127.0.0.1:8000/v1',
              model: 'qwen3:0.6b',
              spentCents: paypalUsed,
              limitCents: paypalLimit,
              keySpentCents: Math.min(PREVIEW.replyCents, paypalUsed),
              keyLimitCents: 100,
              usageUncertain: false,
              disconnecting: false,
              usageState: PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
            }
          : null,
        error: null,
      });
    },
    copy: async () => {
      await navigator.clipboard.writeText('PREVIEW_ONLY_NOT_A_VALID_API_KEY');
      return true;
    },
  };
  const history = Array.from({ length: 24 }, (_, index) => {
    const amount = index % PREVIEW.voidEvery === 0 ? 0 : PREVIEW.capturedCents;
    return {
      id: (index + PREVIEW.referenceOffset)
        .toString(PREVIEW.referenceRadix)
        .padEnd(PREVIEW.paymentIdCharacters, '0'),
      phase: amount
        ? PAYPAL_SESSION_PHASE.COMPLETED
        : PAYPAL_SESSION_PHASE.VOIDED,
      limitCents: 500,
      recordedCents: amount,
      chatCount: amount ? 2 : 0,
      agentCount: amount ? 1 : 0,
      chatCents: amount ? PREVIEW.recordedCents : 0,
      agentCents: amount ? PREVIEW.replyCents : 0,
      unconfirmedCents: 0,
      capturedCents: amount || null,
      needsReview: false,
      firstObservedAt: now - (index + 1) * PREVIEW.dayMs,
      updatedAt: now - (index + 1) * PREVIEW.dayMs + PREVIEW.minuteMs,
    };
  });
  const desktopActivity = {
    summary: async () => ({
      available: true,
      currentSessionId: paypalId,
      sessions: [
        {
          id: paypalId,
          phase: paypalPhase,
          limitCents: paypalLimit,
          recordedCents: paypalUsed,
          chatCount: Math.max(0, paypalUsed / PREVIEW.replyCents - 1),
          agentCount: paypalUsed ? 1 : 0,
          chatCents: Math.max(0, paypalUsed - PREVIEW.replyCents),
          agentCents: Math.min(PREVIEW.replyCents, paypalUsed),
          unconfirmedCents: 0,
          capturedCents:
            paypalPhase === PAYPAL_SESSION_PHASE.COMPLETED ? paypalUsed : null,
          needsReview: false,
          firstObservedAt: now - PREVIEW.halfHourMs,
          updatedAt: now,
        },
        ...history,
      ],
    }),
    references: async () => ({
      available: true,
      references: history
        .filter((row) => row.capturedCents)
        .map((row, index) => ({
          sessionId: row.id,
          kind: 'capture',
          id: `PREVIEWCAP${String(index + 1).padStart(PREVIEW.referencePadding, '0')}`,
        })),
    }),
    copyReference: async () => true,
  };
  return { desktopPaypal, desktopPaypalAgent, desktopActivity };
}
