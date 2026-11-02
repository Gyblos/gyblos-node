// Validates the desktop main-frame IPC boundary before touching a sandbox session.
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

function request(value: unknown): PaypalRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = Object.fromEntries(Object.entries(value));
  const keys = Object.keys(item).sort().join(',');
  switch (item.action) {
    case PAYPAL_ACTION.STATUS:
    case PAYPAL_ACTION.CREATE:
    case PAYPAL_ACTION.OPEN:
    case PAYPAL_ACTION.APPROVE:
    case PAYPAL_ACTION.FINISH:
    case PAYPAL_ACTION.ABANDON:
      return keys === 'action' ? { action: item.action } : null;
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
            break;
          case PAYPAL_ACTION.CREATE:
            await service.create();
            break;
          case PAYPAL_ACTION.OPEN:
            await service.openApproval();
            break;
          case PAYPAL_ACTION.APPROVE:
            await service.approve();
            break;
          case PAYPAL_ACTION.SEND:
            answer = await service.send(input.prompt);
            break;
          case PAYPAL_ACTION.ACKNOWLEDGE:
            await service.acknowledge(input.messageId);
            break;
          case PAYPAL_ACTION.FINISH:
            await service.finish();
            break;
          case PAYPAL_ACTION.ABANDON:
            await service.abandon();
            break;
        }
      } catch (failure) {
        error =
          failure instanceof PaypalError &&
          failure.code === PAYPAL_ERROR_CODES.NOT_APPROVED
            ? PAYPAL_DESKTOP_ERROR.NOT_APPROVED
            : PAYPAL_DESKTOP_ERROR.FAILED;
      }
      return { status: service.status(), model, answer, error };
    },
  };
}
