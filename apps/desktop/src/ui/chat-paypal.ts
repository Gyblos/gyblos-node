// Sends a shared conversation turn through the existing guarded PayPal coordinator.
// Transcript updates never authorize, capture, retry or settle payments.
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';

import type { PaypalChatController } from '../paypal-chat';
import { modelArtwork } from './announced-models';
import type { ChatController } from './chat-controller';
import { CHAT_ROLE } from './constants';

type PaypalSnapshot = ReturnType<PaypalChatController['getSnapshot']>;
export function canSendPaypal(state: PaypalSnapshot) {
  const status = state.status;
  return (
    state.statusFresh &&
    !state.busy &&
    !state.pendingMessageId &&
    status?.phase === PAYPAL_SESSION_PHASE.ACTIVE &&
    !status.expired &&
    status.remainingAttempts > 0 &&
    status.spentCents + status.messageCents <= status.limitCents
  );
}
function localModel(name: string | null) {
  const label = name ?? 'Local model';
  return { id: label, name: label, image: modelArtwork(label), free: false };
}
export async function sendPaypalMessage(
  chat: ChatController,
  paypal: PaypalChatController,
  id: string,
  paymentSessionId?: string,
) {
  if (!canSendPaypal(paypal.getSnapshot())) return false;
  const state = chat.getSnapshot();
  const session = state.sessions.find((item) => item.id === state.activeId)!;
  const origin = chat.startPaypal(
    session.draft,
    localModel(paypal.getSnapshot().model),
    id,
    paymentSessionId ?? paypal.getSnapshot().sessionId ?? undefined,
  );
  if (!origin) return false;
  paypal.setDraft(session.draft);
  const previousCount = paypal.getSnapshot().messages.length;
  let received = false;
  const unsubscribe = paypal.subscribe(() => {
    const current = paypal.getSnapshot();
    const user = current.messages[previousCount];
    const answer = current.messages[previousCount + 1];
    if (
      received ||
      user?.role !== CHAT_ROLE.USER ||
      user.text !== session.draft ||
      answer?.role !== CHAT_ROLE.ASSISTANT
    )
      return;
    received = true;
    chat.completePaypal(
      origin,
      id,
      answer.text || '(Empty response)',
      localModel(current.model),
    );
  });
  try {
    await paypal.send();
    if (!received)
      chat.failPaypal(
        origin,
        id,
        paypal.getSnapshot().notice ||
          'Response unavailable. Review the session in Payments before sending again.',
      );
  } finally {
    unsubscribe();
  }
  return true;
}
