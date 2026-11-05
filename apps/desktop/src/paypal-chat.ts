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
import { CHAT_PREVIEW, CHAT_ROLE } from './ui/constants';

type ScrollViewport = {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
};

export class PaypalChatScroll {
  private following = true;

  observe(viewport: ScrollViewport) {
    this.following =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
      CHAT_PREVIEW.FOLLOW_THRESHOLD;
    return this.following;
  }

  follow(viewport: ScrollViewport) {
    if (this.following) viewport.scrollTop = viewport.scrollHeight;
  }

  latest(viewport: ScrollViewport) {
    this.following = true;
    this.follow(viewport);
  }
}

type Message = {
  role: (typeof CHAT_ROLE)[keyof typeof CHAT_ROLE];
  text: string;
};
type Snapshot = {
  status: DesktopPaypalStatus | null;
  statusFresh: boolean;
  model: string | null;
  messages: Message[];
  draft: string;
  pendingPrompt: string | null;
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
    return result.status?.approvalLinkAvailable
      ? 'Approve the request in PayPal Sandbox before starting the session.'
      : 'PayPal has not confirmed approval. If already approved, check again; otherwise abandon this order and start a new session.';
  if (result.error === PAYPAL_DESKTOP_ERROR.INTERRUPTED)
    return 'The approval check was interrupted before authorization.';
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
    statusFresh: false,
    model: null,
    messages: [],
    draft: '',
    pendingPrompt: null,
    busy: false,
    notice: '',
    pendingMessageId: null,
  };
  private readonly listeners = new Set<() => void>();
  private draftRevision = 0;
  private polling = false;
  private returnPending = false;
  private returning = false;
  private cancellationPending = false;
  constructor(private readonly run: Run) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  setDraft(draft: string) {
    this.draftRevision++;
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
    const previous = this.snapshot.status;
    this.update({
      busy: true,
      ...(request.action === PAYPAL_ACTION.STATUS ? {} : { notice: '' }),
    });
    const result = await this.call(request);
    if (
      request.action === PAYPAL_ACTION.APPROVE &&
      result.error &&
      result.error !== PAYPAL_DESKTOP_ERROR.NOT_APPROVED
    )
      this.returnPending = false;
    const notice = result.error
      ? failure(result)
      : request.action === PAYPAL_ACTION.FINISH &&
          result.status?.phase === PAYPAL_SESSION_PHASE.ACTIVE
        ? 'Session remains open. No payment was requested.'
        : needsReview(result.status, this.snapshot.pendingMessageId)
          ? 'A prior response awaits confirmation. Review the session.'
          : request.action === PAYPAL_ACTION.STATUS &&
              result.status?.phase === previous?.phase
            ? this.snapshot.notice
            : '';
    this.update({
      status: result.status,
      statusFresh: result.status !== null,
      model: result.model,
      notice,
      busy: false,
      ...(request.action === PAYPAL_ACTION.CREATE &&
      !result.error &&
      result.status?.phase === PAYPAL_SESSION_PHASE.CREATED
        ? { messages: [], pendingMessageId: null }
        : {}),
    });
    if (request.action !== PAYPAL_ACTION.COMPLETE_RETURN)
      await this.consumeReturn();
    await this.consumeCancellation();
  }
  private async consumeReturn() {
    if (!this.returnPending || this.returning || this.snapshot.busy) return;
    this.returnPending = false;
    this.returning = true;
    try {
      await this.command({ action: PAYPAL_ACTION.COMPLETE_RETURN });
    } finally {
      this.returning = false;
    }
  }
  returnedFromPaypal = async () => {
    if (this.returning || this.returnPending) return;
    this.returnPending = true;
    await this.consumeReturn();
  };
  private async consumeCancellation() {
    if (!this.cancellationPending || this.snapshot.busy) return;
    this.cancellationPending = false;
    this.update({ busy: true });
    const result = await this.call({ action: PAYPAL_ACTION.COMPLETE_CANCEL });
    if (!result.error && !result.status) {
      this.update({ busy: false });
      await this.consumeReturn();
      return;
    }
    this.update({
      status: result.status,
      statusFresh: result.status !== null,
      model: result.model,
      busy: false,
      notice: result.error
        ? failure(result)
        : 'PayPal checkout was cancelled. Abandon this order to start a new session.',
    });
    await this.consumeReturn();
  }
  cancelledFromPaypal = async () => {
    this.cancellationPending = true;
    await this.consumeCancellation();
  };
  refresh = () => this.command({ action: PAYPAL_ACTION.STATUS });
  async poll() {
    if (this.snapshot.busy || this.polling) return;
    this.polling = true;
    const previous = this.snapshot.status;
    try {
      const result = await this.call({ action: PAYPAL_ACTION.STATUS });
      if (!this.snapshot.busy && this.snapshot.status === previous) {
        if (result.error || !result.status) this.update({ statusFresh: false });
        else
          this.update({
            status: result.status,
            statusFresh: true,
            model: result.model,
          });
      }
    } finally {
      this.polling = false;
    }
  }
  create = () => {
    if (!this.snapshot.statusFresh) return Promise.resolve();
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
  startCheckout = async () => {
    if (!this.snapshot.statusFresh) return;
    const phase = this.snapshot.status?.phase;
    if (
      phase !== PAYPAL_SESSION_STATUS.READY &&
      phase !== PAYPAL_SESSION_PHASE.COMPLETED &&
      phase !== PAYPAL_SESSION_PHASE.VOIDED &&
      phase !== PAYPAL_SESSION_PHASE.CANCELLED
    )
      return;
    await this.create();
    if (
      this.snapshot.status?.phase === PAYPAL_SESSION_PHASE.CREATED &&
      this.snapshot.status.approvalLinkAvailable &&
      !this.snapshot.notice
    )
      await this.openApproval();
  };
  openApproval = () => {
    if (
      !this.snapshot.statusFresh ||
      this.snapshot.status?.phase !== PAYPAL_SESSION_PHASE.CREATED
    )
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.OPEN });
  };
  approve = () => {
    if (
      !this.snapshot.statusFresh ||
      this.snapshot.status?.phase !== PAYPAL_SESSION_PHASE.CREATED
    )
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.APPROVE });
  };
  abandon = () => {
    if (
      !this.snapshot.statusFresh ||
      this.snapshot.status?.phase !== PAYPAL_SESSION_PHASE.CREATED
    )
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.ABANDON });
  };
  finish = () => {
    if (
      !this.snapshot.statusFresh ||
      this.snapshot.status?.phase !== PAYPAL_SESSION_PHASE.ACTIVE ||
      this.snapshot.pendingMessageId
    )
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.FINISH });
  };
  reviewAndSettle = () => {
    if (
      !this.snapshot.statusFresh ||
      this.snapshot.status?.phase !== PAYPAL_SESSION_PHASE.EXECUTING ||
      this.snapshot.status.spentCents <= 0 ||
      this.snapshot.pendingMessageId
    )
      return Promise.resolve();
    return this.command({ action: PAYPAL_ACTION.REVIEW_AND_SETTLE });
  };
  async send() {
    const { status, draft, busy, pendingMessageId } = this.snapshot;
    if (
      busy ||
      !this.snapshot.statusFresh ||
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
    const draftRevision = this.draftRevision;
    this.update({ busy: true, notice: '', pendingPrompt: draft, draft: '' });
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
        statusFresh: result.status !== null,
        model: result.model,
        notice: failure(result),
        draft:
          this.draftRevision === draftRevision ? draft : this.snapshot.draft,
        pendingPrompt: null,
        busy: false,
      });
      return;
    }
    this.update({
      status: result.status,
      statusFresh: true,
      model: result.model,
      pendingPrompt: null,
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
        statusFresh: result.status !== null,
        model: result.model,
        notice:
          'The response arrived but its acknowledgment is pending. Retry acknowledgment only.',
      });
      return;
    }
    this.update({
      status: result.status,
      statusFresh: true,
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
