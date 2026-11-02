// Coordinates one visible sandbox chat and acknowledges only responses received by the renderer.
import {
  PAYPAL_REQUEST_LIMITS,
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';

import {
  parsePaypalResult,
  PAYPAL_ACTION,
  PAYPAL_DESKTOP_ERROR,
  paypalFailure,
  type PaypalRequest,
  type PaypalResult,
} from './paypal-model';
import type { DesktopPaypalStatus } from './paypal-session';
import { CHAT_ROLE } from './ui/constants';

type Message = {
  role: (typeof CHAT_ROLE)[keyof typeof CHAT_ROLE];
  text: string;
};
type Snapshot = {
  status: DesktopPaypalStatus | null;
  model: string | null;
  messages: Message[];
  draft: string;
  busy: boolean;
  notice: string;
  pendingMessageId: string | null;
};
type Run = (request: PaypalRequest) => Promise<PaypalResult>;

function failure(result: PaypalResult) {
  if (
    result.error === PAYPAL_DESKTOP_ERROR.INVALID_PROMPT &&
    result.status?.expired
  )
    return 'The sandbox session has expired. Close it to settle recorded usage.';
  if (
    result.error === PAYPAL_DESKTOP_ERROR.INVALID_PROMPT &&
    result.status &&
    (result.status.remainingAttempts === 0 ||
      result.status.spentCents + result.status.messageCents >
        result.status.limitCents)
  )
    return 'The sandbox session limit has been reached. Close it to settle recorded usage.';
  if (result.error === PAYPAL_DESKTOP_ERROR.INVALID_PROMPT)
    return 'Shorten the message or remove reserved model control markers, then try again.';
  if (result.error === PAYPAL_DESKTOP_ERROR.NOT_APPROVED)
    return 'Approve the request in PayPal Sandbox before starting the session.';
  if (result.error === PAYPAL_DESKTOP_ERROR.UNAVAILABLE)
    return 'PayPal Sandbox is unavailable. Check its configuration and the local model.';
  return 'The operation could not be confirmed. Check the session before continuing.';
}
function needsReview(
  status: DesktopPaypalStatus | null,
  pending: string | null,
) {
  return status?.phase === PAYPAL_SESSION_PHASE.MESSAGE_PENDING && !pending;
}

export class PaypalChatController {
  private snapshot: Snapshot = {
    status: null,
    model: null,
    messages: [],
    draft: '',
    busy: false,
    notice: '',
    pendingMessageId: null,
  };
  private readonly listeners = new Set<() => void>();
  private polling = false;
  constructor(private readonly run: Run) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  setDraft(draft: string) {
    this.update({ draft });
  }
  private update(values: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...values };
    for (const listener of this.listeners) listener();
  }
  private async call(request: PaypalRequest) {
    try {
      return parsePaypalResult(await this.run(request));
    } catch {
      return paypalFailure();
    }
  }
  private async command(request: PaypalRequest) {
    if (this.snapshot.busy) return;
    this.update({ busy: true, notice: '' });
    const result = await this.call(request);
    const notice = result.error
      ? failure(result)
      : needsReview(result.status, this.snapshot.pendingMessageId)
        ? 'A response awaits confirmation. Check Connect; if none is available, review the session.'
        : '';
    this.update({
      status: result.status,
      model: result.model,
      notice,
      busy: false,
      ...(request.action === PAYPAL_ACTION.CREATE &&
      !result.error &&
      result.status?.phase === PAYPAL_SESSION_PHASE.CREATED
        ? { messages: [], pendingMessageId: null }
        : {}),
    });
  }
  refresh = () => this.command({ action: PAYPAL_ACTION.STATUS });
  async poll() {
    if (this.snapshot.busy || this.polling) return;
    this.polling = true;
    const previous = this.snapshot.status;
    try {
      const result = await this.call({ action: PAYPAL_ACTION.STATUS });
      if (
        !result.error &&
        !this.snapshot.busy &&
        this.snapshot.status === previous
      )
        this.update({ status: result.status, model: result.model });
    } finally {
      this.polling = false;
    }
  }
  create = () => {
    const phase = this.snapshot.status?.phase;
    if (
      phase !== PAYPAL_SESSION_STATUS.READY &&
      phase !== PAYPAL_SESSION_PHASE.COMPLETED &&
      phase !== PAYPAL_SESSION_PHASE.VOIDED &&
      phase !== PAYPAL_SESSION_PHASE.CANCELLED
    )
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.CREATE });
  };
  openApproval = () => {
    if (this.snapshot.status?.phase !== PAYPAL_SESSION_PHASE.CREATED)
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.OPEN });
  };
  approve = () => {
    if (this.snapshot.status?.phase !== PAYPAL_SESSION_PHASE.CREATED)
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.APPROVE });
  };
  abandon = () => {
    if (this.snapshot.status?.phase !== PAYPAL_SESSION_PHASE.CREATED)
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.ABANDON });
  };
  finish = () => {
    if (
      this.snapshot.status?.phase !== PAYPAL_SESSION_PHASE.ACTIVE ||
      this.snapshot.pendingMessageId
    )
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.FINISH });
  };
  async send() {
    const { status, draft, busy, pendingMessageId } = this.snapshot;
    if (
      busy ||
      pendingMessageId ||
      !draft.trim() ||
      status?.phase !== PAYPAL_SESSION_PHASE.ACTIVE ||
      status.expired ||
      status.remainingAttempts === 0 ||
      status.spentCents + status.messageCents > status.limitCents
    )
      return;
    if (
      new TextEncoder().encode(draft).length > PAYPAL_REQUEST_LIMITS.promptBytes
    ) {
      this.update({
        notice: failure(paypalFailure(PAYPAL_DESKTOP_ERROR.INVALID_PROMPT)),
      });
      return;
    }
    this.update({ busy: true, notice: '' });
    const result = await this.call({
      action: PAYPAL_ACTION.SEND,
      prompt: draft,
    });
    if (
      result.error ||
      !result.answer ||
      result.status?.phase !== PAYPAL_SESSION_PHASE.MESSAGE_PENDING
    ) {
      this.update({
        status: result.status,
        model: result.model,
        notice: failure(result),
        busy: false,
      });
      return;
    }
    this.update({
      status: result.status,
      model: result.model,
      draft: this.snapshot.draft === draft ? '' : this.snapshot.draft,
      messages: [
        ...this.snapshot.messages,
        { role: CHAT_ROLE.USER, text: draft },
        { role: CHAT_ROLE.ASSISTANT, text: result.answer.text },
      ],
      pendingMessageId: result.answer.messageId,
    });
    await this.acknowledge(result.answer.messageId);
    this.update({ busy: false });
  }
  private async acknowledge(messageId: string) {
    const result = await this.call({
      action: PAYPAL_ACTION.ACKNOWLEDGE,
      messageId,
    });
    if (result.error || result.status?.phase !== PAYPAL_SESSION_PHASE.ACTIVE) {
      this.update({
        status: result.status,
        model: result.model,
        notice:
          'The response arrived but its acknowledgment is pending. Retry acknowledgment only.',
      });
      return;
    }
    this.update({
      status: result.status,
      model: result.model,
      pendingMessageId: null,
      notice: '',
    });
  }
  async retryAcknowledgement() {
    const id = this.snapshot.pendingMessageId;
    if (!id || this.snapshot.busy) return;
    this.update({ busy: true, notice: '' });
    await this.acknowledge(id);
    this.update({ busy: false });
  }
}
