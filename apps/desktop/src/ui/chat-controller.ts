// Coordinates in-memory chat sessions and synthetic response timers for the renderer.
// Never writes files or calls providers, wallets, tools or payment services.
import type { ReasoningLevel } from '@gyblos/protocol/constants';

import { restoreChatArchive, type ChatArchive } from '../chat-archive-model';
import { PAYMENT_METHOD, type PaymentMethod } from '../paypal-model';
import {
  advanceRun,
  createSession,
  startRun,
  stopRun,
  type ChatSession,
} from './chat-state';
import {
  CHAT_PHASE,
  CHAT_PREVIEW,
  CHAT_ROLE,
  DEMO_AUTH,
  MESSAGE_STATE,
} from './constants';
import {
  chatAuthorizationNotice,
  type DemoAuthorizationStatus,
} from './demo-account';
import type { ChatModel } from './model-types';
import type { ToolId } from './tools';

export type ChatScheduler = {
  schedule: (callback: () => void, delay: number) => () => void;
};
type Snapshot = { sessions: ChatSession[]; activeId: string };
type ScheduledRun = {
  run: NonNullable<ChatSession['run']>;
  cancel: () => void;
};

export class ChatController {
  private snapshot: Snapshot;
  private online = true;
  private restoring = false;
  private scheduler: ChatScheduler | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ScheduledRun>();

  constructor(
    firstId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.snapshot = { sessions: [createSession(firstId)], activeId: firstId };
  }
  getSnapshot = () => this.snapshot;
  setRestoring(value: boolean) {
    this.restoring = value;
  }
  restoreArchive(archive: ChatArchive) {
    this.publish(restoreChatArchive(archive));
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  attachScheduler(scheduler: ChatScheduler) {
    this.scheduler = scheduler;
    this.syncTimers();
    return () => {
      if (this.scheduler !== scheduler) return;
      for (const timer of this.timers.values()) timer.cancel();
      this.timers.clear();
      this.scheduler = null;
    };
  }
  setOnline(online: boolean) {
    if (this.online === online) return;
    this.online = online;
    this.publish({
      ...this.snapshot,
      sessions: online
        ? this.snapshot.sessions
        : this.snapshot.sessions.map(stopRun),
    });
  }
  newChat(id: string, draft = '') {
    if (this.restoring) return;
    this.publish({
      activeId: id,
      sessions: [...this.snapshot.sessions, { ...createSession(id), draft }],
    });
  }
  openChat(id: string) {
    if (this.restoring) return;
    if (
      id === this.snapshot.activeId ||
      !this.snapshot.sessions.some((item) => item.id === id)
    )
      return;
    this.publish({ activeId: id, sessions: this.snapshot.sessions });
  }
  setDraft(draft: string) {
    if (this.restoring) return;
    this.updateActive((session) => ({
      ...session,
      draft,
      draftRevision: session.draftRevision + 1,
    }));
  }
  setNotice(notice: string, sessionId = this.snapshot.activeId) {
    this.publish({
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, notice, blocked: null }
          : session,
      ),
    });
  }
  modelChanged(free: boolean) {
    if (!free) return;
    const sessions = this.snapshot.sessions.map((session) =>
      session.blocked === DEMO_AUTH.BALANCE ||
      session.blocked === DEMO_AUTH.LIMIT
        ? { ...session, notice: '', blocked: null }
        : session,
    );
    if (
      sessions.some(
        (session, index) => session !== this.snapshot.sessions[index],
      )
    )
      this.publish({ ...this.snapshot, sessions });
  }
  stop() {
    this.updateActive(stopRun);
  }
  start(
    text: string,
    model: ChatModel,
    tools: ToolId[],
    runId: string,
    authorize: () => DemoAuthorizationStatus,
    reasoning?: ReasoningLevel,
  ) {
    if (this.restoring) return false;
    const session = this.snapshot.sessions.find(
      (item) => item.id === this.snapshot.activeId,
    )!;
    if (session.run || session.paypalRun || !text.trim()) return false;
    const status = this.online ? authorize() : DEMO_AUTH.OFFLINE;
    if (status !== DEMO_AUTH.APPROVED) {
      this.updateActive((item) => ({
        ...item,
        notice: chatAuthorizationNotice(status),
        blocked: status,
      }));
      return false;
    }
    this.updateActive((item) => ({
      ...startRun(item, text, model, tools, runId, this.now(), reasoning),
      notice: '',
      blocked: null,
    }));
    return true;
  }
  // Records display state only. The PayPal coordinator retains all payment guards.
  startPaypal(
    prompt: string,
    model: ChatModel,
    id: string,
    paymentSessionId?: string,
    method: PaymentMethod = PAYMENT_METHOD.PAYPAL,
  ) {
    if (this.restoring) return null;
    const session = this.snapshot.sessions.find(
      (item) => item.id === this.snapshot.activeId,
    )!;
    if (session.run || session.paypalRun || !prompt.trim()) return null;
    this.updateActive((item) => ({
      ...item,
      title: item.messages.length
        ? item.title
        : prompt.trim().slice(0, CHAT_PREVIEW.TITLE_LENGTH),
      draft: '',
      notice: '',
      blocked: null,
      paypalRun: { id, prompt, draftRevision: item.draftRevision },
      messages: [
        ...item.messages,
        {
          id: `${id}-user`,
          role: CHAT_ROLE.USER,
          text: prompt,
          model: { ...model },
          state: MESSAGE_STATE.COMPLETE,
          tools: [],
          paymentMethod: method,
          ...(paymentSessionId ? { paymentSessionId } : {}),
          sentAt: this.now(),
        },
        {
          id: `${id}-assistant`,
          role: CHAT_ROLE.ASSISTANT,
          text: '',
          model: { ...model },
          state: MESSAGE_STATE.PENDING,
          tools: [],
          paymentMethod: method,
          ...(paymentSessionId ? { paymentSessionId } : {}),
          sentAt: null,
        },
      ],
    }));
    return session.id;
  }
  completePaypal(
    sessionId: string,
    id: string,
    text: string,
    model: ChatModel,
  ) {
    this.updatePaypal(sessionId, id, (session) => ({
      ...session,
      paypalRun: null,
      messages: session.messages.map((message) =>
        message.id === `${id}-assistant`
          ? {
              ...message,
              text,
              model: { ...model },
              state: MESSAGE_STATE.COMPLETE,
            }
          : message,
      ),
    }));
  }
  failPaypal(sessionId: string, id: string, notice: string) {
    this.updatePaypal(sessionId, id, (session) => ({
      ...session,
      draft:
        session.draftRevision === session.paypalRun?.draftRevision
          ? session.paypalRun.prompt
          : session.draft,
      paypalRun: null,
      notice,
      messages: session.messages.map((message) =>
        message.id === `${id}-assistant`
          ? { ...message, state: MESSAGE_STATE.FAILED }
          : message,
      ),
    }));
  }
  private updatePaypal(
    sessionId: string,
    id: string,
    update: (session: ChatSession) => ChatSession,
  ) {
    this.publish({
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((session) =>
        session.id === sessionId && session.paypalRun?.id === id
          ? update(session)
          : session,
      ),
    });
  }
  private updateActive(update: (session: ChatSession) => ChatSession) {
    this.publish({
      ...this.snapshot,
      sessions: this.snapshot.sessions.map((item) =>
        item.id === this.snapshot.activeId ? update(item) : item,
      ),
    });
  }
  private publish(snapshot: Snapshot) {
    this.snapshot = snapshot;
    this.syncTimers();
    for (const listener of this.listeners) listener();
  }
  private syncTimers() {
    if (!this.scheduler) return;
    const sessions = this.snapshot.sessions;
    for (const [id, timer] of this.timers) {
      if (sessions.find((item) => item.id === id)?.run === timer.run) continue;
      timer.cancel();
      this.timers.delete(id);
    }
    for (const session of sessions) {
      const run = session.run;
      if (!run || this.timers.has(session.id)) continue;
      const delay =
        run.phase === CHAT_PHASE.RESPONDING
          ? CHAT_PREVIEW.STREAM_DELAY_MS
          : run.phase === CHAT_PHASE.TOOLS
            ? CHAT_PREVIEW.TOOL_DELAY_MS
            : CHAT_PREVIEW.CONNECT_DELAY_MS;
      const timer: ScheduledRun = { run, cancel: () => {} };
      timer.cancel = this.scheduler.schedule(() => {
        if (this.timers.get(session.id) !== timer) return;
        this.timers.delete(session.id);
        this.publish({
          ...this.snapshot,
          sessions: this.snapshot.sessions.map((item) =>
            item.id === session.id ? advanceRun(item, run.id) : item,
          ),
        });
      }, delay);
      this.timers.set(session.id, timer);
    }
  }
}
