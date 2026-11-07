// Validates the desktop main-frame IPC boundary before touching a sandbox session.
import { PAYPAL_SANDBOX_LIMIT_OPTIONS } from '@gyblos/config/constants';
import { PAYPAL_REQUEST_LIMITS } from '@gyblos/node/constants';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { isPaypalId, PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_ACTION,
  PAYPAL_DESKTOP_ERROR,
  paypalFailure,
  type PaypalRequest,
  type PaypalResult,
} from './paypal-model';
import type { createDesktopPaypalSession } from './paypal-session';

type DesktopSession = ReturnType<typeof createDesktopPaypalSession>;
type DesktopWindow = {
  contents: unknown;
  mainFrame(): unknown;
  destroyed(): boolean;
};
type DesktopSender = { sender: unknown; senderFrame: unknown };
type Loaded = { service: DesktopSession; model: string };
type ConfirmReview = (ticket: {
  fingerprint: string;
  spentCents: number;
}) => Promise<boolean>;
type ConfirmFinish = (summary: {
  spentCents: number;
  limitCents: number;
}) => Promise<boolean>;

function actionError(failure: unknown, input: PaypalRequest) {
  if (failure instanceof PaypalError) {
    if (failure.code === PAYPAL_ERROR_CODES.NOT_APPROVED)
      return PAYPAL_DESKTOP_ERROR.NOT_APPROVED;
    if (failure.code === PAYPAL_ERROR_CODES.INTERRUPTED)
      return PAYPAL_DESKTOP_ERROR.INTERRUPTED;
    if (
      input.action === PAYPAL_ACTION.SEND &&
      failure.code === PAYPAL_ERROR_CODES.INVALID_REQUEST
    )
      return PAYPAL_DESKTOP_ERROR.INVALID_PROMPT;
  }
  return PAYPAL_DESKTOP_ERROR.FAILED;
}

function request(value: unknown): PaypalRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = Object.fromEntries(Object.entries(value));
  const keys = Object.keys(item).sort().join(',');
  switch (item.action) {
    case PAYPAL_ACTION.STATUS:
    case PAYPAL_ACTION.OPEN:
    case PAYPAL_ACTION.APPROVE:
    case PAYPAL_ACTION.COMPLETE_RETURN:
    case PAYPAL_ACTION.COMPLETE_CANCEL:
    case PAYPAL_ACTION.FINISH:
    case PAYPAL_ACTION.CHECK_VOID:
    case PAYPAL_ACTION.REVIEW_AND_SETTLE:
    case PAYPAL_ACTION.ABANDON:
      return keys === 'action' ? { action: item.action } : null;
    case PAYPAL_ACTION.CREATE:
      if (keys === 'action') return { action: PAYPAL_ACTION.CREATE };
      return keys === 'action,limitCents' &&
        typeof item.limitCents === 'number' &&
        PAYPAL_SANDBOX_LIMIT_OPTIONS.some((limit) => limit === item.limitCents)
        ? { action: PAYPAL_ACTION.CREATE, limitCents: item.limitCents }
        : null;
    case PAYPAL_ACTION.SEND:
      return keys === 'action,prompt' &&
        typeof item.prompt === 'string' &&
        item.prompt.trim().length > 0 &&
        Buffer.byteLength(item.prompt, 'utf8') <=
          PAYPAL_REQUEST_LIMITS.promptBytes
        ? { action: PAYPAL_ACTION.SEND, prompt: item.prompt }
        : null;
    case PAYPAL_ACTION.ACKNOWLEDGE:
      return keys === 'action,messageId' && isPaypalId(item.messageId)
        ? { action: PAYPAL_ACTION.ACKNOWLEDGE, messageId: item.messageId }
        : null;
    default:
      return null;
  }
}
export function createDesktopPaypalHandlers(
  load: () => Promise<Loaded>,
  window: DesktopWindow,
  confirmReview: ConfirmReview = async () => false,
  confirmFinish: ConfirmFinish = async () => false,
) {
  return {
    async run(
      event: DesktopSender,
      args: readonly unknown[],
    ): Promise<PaypalResult> {
      if (
        window.destroyed() ||
        event.sender !== window.contents ||
        event.senderFrame !== window.mainFrame() ||
        args.length !== 1
      )
        return paypalFailure(PAYPAL_DESKTOP_ERROR.DENIED);
      const input = request(args[0]);
      if (!input) return paypalFailure(PAYPAL_DESKTOP_ERROR.INVALID);
      let loaded: Loaded;
      try {
        loaded = await load();
      } catch {
        return paypalFailure(PAYPAL_DESKTOP_ERROR.UNAVAILABLE);
      }
      const { service, model } = loaded;
      let answer: PaypalResult['answer'] = null;
      let error: PaypalResult['error'] = null;
      try {
        switch (input.action) {
          case PAYPAL_ACTION.STATUS:
          case PAYPAL_ACTION.CHECK_VOID:
            if (input.action === PAYPAL_ACTION.CHECK_VOID)
              await service.checkVoidedAuthorization();
            break;
          case PAYPAL_ACTION.CREATE:
            await service.create(input.limitCents);
            break;
          case PAYPAL_ACTION.OPEN:
            await service.openApproval();
            break;
          case PAYPAL_ACTION.APPROVE:
            await service.approve();
            break;
          case PAYPAL_ACTION.COMPLETE_RETURN:
            await service.consumeApprovedReturn();
            break;
          case PAYPAL_ACTION.COMPLETE_CANCEL:
            if (!(await service.consumeCancelledReturn()))
              return { status: null, model, answer: null, error: null };
            break;
          case PAYPAL_ACTION.SEND:
            answer = await service.send(input.prompt);
            break;
          case PAYPAL_ACTION.ACKNOWLEDGE:
            await service.acknowledge(input.messageId);
            break;
          case PAYPAL_ACTION.FINISH:
            await service.finishWithConfirmation(confirmFinish);
            break;
          case PAYPAL_ACTION.REVIEW_AND_SETTLE:
            await service.reviewAndSettle(confirmReview);
            break;
          case PAYPAL_ACTION.ABANDON:
            await service.abandon();
            break;
        }
      } catch (failure) {
        error = actionError(failure, input);
      }
      return visibleResult(service, model, answer, error);
    },
  };
}

function visibleResult(
  service: DesktopSession,
  model: string,
  answer: PaypalResult['answer'],
  error: PaypalResult['error'],
): PaypalResult {
  const sessionId = service.activity()?.id;
  return {
    status: service.status(),
    model,
    answer,
    error,
    ...(sessionId ? { sessionId } : {}),
  };
}
