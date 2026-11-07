// Bounded local conversation data only; excludes execution, credentials and payment authority.
import { REASONING_LEVELS } from '@gyblos/protocol/constants';

import { activityId } from './activity-model';
import { CHAT_STORAGE } from './constants';
import { PAYMENT_METHOD, type PaymentMethod } from './paypal-model';
import { modelArtwork } from './ui/announced-models';
import {
  createSession,
  type ChatMessage,
  type ChatSession,
  type ChatSnapshot,
} from './ui/chat-state';
import { CHAT_ROLE, MESSAGE_STATE, TOOLS } from './ui/constants';
import type { ChatModel } from './ui/model-types';

export {
  CHAT_STORAGE,
  CHAT_STORAGE_STATE,
  type ChatArchiveState,
} from './constants';
export type ArchivedMessage = Omit<ChatMessage, 'model'> & {
  model: Omit<ChatModel, 'image'>;
};
export type ArchivedConversation = Pick<
  ChatSession,
  'id' | 'title' | 'draft'
> & { messages: ArchivedMessage[] };
export type ChatArchive = {
  version: typeof CHAT_STORAGE.VERSION;
  activeId: string;
  sessions: ArchivedConversation[];
};
export type ChatArchiveStatus = {
  available: boolean;
  generation: number;
  savedSequence: number;
};
export type ChatArchiveLoad = ChatArchiveStatus & {
  archive: ChatArchive | null;
};
export type ChatArchiveSave = {
  generation: number;
  sequence: number;
  archive: ChatArchive;
};
export function unavailableChatArchive(): ChatArchiveStatus {
  return { available: false, generation: 0, savedSequence: 0 };
}
function object(value: unknown, keys: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = Object.fromEntries(Object.entries(value));
  return Object.keys(item).sort().join(',') === keys ? item : null;
}
function text(
  value: unknown,
  max: number = CHAT_STORAGE.MAX_TEXT_CHARACTERS,
): value is string {
  return typeof value === 'string' && value.length <= max;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && CHAT_STORAGE.ID_PATTERN.test(value);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseModel(value: unknown): Omit<ChatModel, 'image'> | null {
  const item = object(value, 'free,id,name');
  return item &&
    text(item.id, CHAT_STORAGE.MAX_MODEL_CHARACTERS) &&
    text(item.name, CHAT_STORAGE.MAX_MODEL_CHARACTERS) &&
    typeof item.free === 'boolean'
    ? { id: item.id, name: item.name, free: item.free }
    : null;
}
function parseMessage(value: unknown): ArchivedMessage | null {
  const reasoningKey =
    value && typeof value === 'object' && 'reasoning' in value
      ? 'reasoning,'
      : '';
  const item =
    object(
      value,
      `id,model,paymentMethod,${reasoningKey}role,sentAt,state,text,tools`,
    ) ??
    object(
      value,
      `id,model,paymentMethod,paymentSessionId,${reasoningKey}role,sentAt,state,text,tools`,
    );
  if (!item) return null;
  const model = parseModel(item.model);
  const reasoning = Object.values(REASONING_LEVELS).find(
    (level) => level === item.reasoning,
  );
  const role = Object.values(CHAT_ROLE).find((entry) => entry === item.role);
  const state = Object.values(MESSAGE_STATE).find(
    (entry) => entry === item.state,
  );
  const method: PaymentMethod | undefined = Object.values(PAYMENT_METHOD).find(
    (entry) => entry === item.paymentMethod,
  );
  if (
    !id(item.id) ||
    !model ||
    !role ||
    !state ||
    !method ||
    ('reasoning' in item && (!reasoning || method !== PAYMENT_METHOD.USDC)) ||
    !text(item.text) ||
    !Array.isArray(item.tools) ||
    item.tools.length > TOOLS.length ||
    (item.sentAt !== null &&
      (!integer(item.sentAt) ||
        !Number.isFinite(new Date(item.sentAt).getTime()))) ||
    ('paymentSessionId' in item &&
      (!activityId(item.paymentSessionId) || method !== PAYMENT_METHOD.PAYPAL))
  )
    return null;
  const tools: ChatMessage['tools'] = [];
  for (const tool of item.tools) {
    const found = TOOLS.find((entry) => entry.id === tool);
    if (!found || tools.includes(found.id)) return null;
    tools.push(found.id);
  }
  return {
    id: item.id,
    role,
    state,
    text: item.text,
    model,
    tools,
    paymentMethod: method,
    sentAt: item.sentAt,
    ...(reasoning ? { reasoning } : {}),
    ...(activityId(item.paymentSessionId)
      ? { paymentSessionId: item.paymentSessionId }
      : {}),
  };
}
function parseConversation(value: unknown): ArchivedConversation | null {
  const item = object(value, 'draft,id,messages,title');
  if (
    !item ||
    !id(item.id) ||
    !text(item.title, CHAT_STORAGE.MAX_TITLE_CHARACTERS) ||
    !text(item.draft) ||
    !Array.isArray(item.messages) ||
    item.messages.length > CHAT_STORAGE.MAX_MESSAGES
  )
    return null;
  const messages: ArchivedMessage[] = [];
  for (const value of item.messages) {
    const message = parseMessage(value);
    if (!message || messages.some((entry) => entry.id === message.id))
      return null;
    messages.push(message);
  }
  return { id: item.id, title: item.title, draft: item.draft, messages };
}
export function parseChatArchive(value: unknown): ChatArchive | null {
  const item = object(value, 'activeId,sessions,version');
  if (
    !item ||
    item.version !== CHAT_STORAGE.VERSION ||
    !id(item.activeId) ||
    !Array.isArray(item.sessions) ||
    item.sessions.length === 0 ||
    item.sessions.length > CHAT_STORAGE.MAX_CONVERSATIONS
  )
    return null;
  const sessions: ArchivedConversation[] = [];
  let characters = 0;
  let messages = 0;
  for (const value of item.sessions) {
    const session = parseConversation(value);
    if (!session || sessions.some((entry) => entry.id === session.id))
      return null;
    characters +=
      session.draft.length +
      session.title.length +
      session.messages.reduce(
        (total, message) => total + message.text.length,
        0,
      );
    messages += session.messages.length;
    if (
      characters > CHAT_STORAGE.MAX_BYTES ||
      messages > CHAT_STORAGE.MAX_MESSAGES
    )
      return null;
    sessions.push(session);
  }
  if (!sessions.some((session) => session.id === item.activeId)) return null;
  const archive: ChatArchive = {
    version: CHAT_STORAGE.VERSION,
    activeId: item.activeId,
    sessions,
  };
  return new TextEncoder().encode(JSON.stringify(archive)).byteLength <=
    CHAT_STORAGE.MAX_BYTES
    ? archive
    : null;
}
export function projectChatArchive(snapshot: ChatSnapshot): ChatArchive | null {
  return parseChatArchive({
    version: CHAT_STORAGE.VERSION,
    activeId: snapshot.activeId,
    sessions: snapshot.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      draft: session.draft,
      messages: session.messages.map((message) => ({
        ...message,
        model: {
          id: message.model.id,
          name: message.model.name,
          free: message.model.free,
        },
      })),
    })),
  });
}
export function restoreChatArchive(archive: ChatArchive): ChatSnapshot {
  return {
    activeId: archive.activeId,
    sessions: archive.sessions.map((session) => ({
      ...createSession(session.id),
      ...session,
      notice: session.messages.some(
        (message) => message.state === MESSAGE_STATE.PENDING,
      )
        ? 'A response was interrupted. Review Payments before sending another PayPal message.'
        : '',
      messages: session.messages.map((message) => ({
        ...message,
        state:
          message.state === MESSAGE_STATE.PENDING
            ? message.paymentMethod === PAYMENT_METHOD.PAYPAL
              ? MESSAGE_STATE.FAILED
              : MESSAGE_STATE.STOPPED
            : message.state,
        model: { ...message.model, image: modelArtwork(message.model.id) },
      })),
    })),
  };
}
export function parseChatArchiveSave(value: unknown): ChatArchiveSave | null {
  const item = object(value, 'archive,generation,sequence');
  if (
    !item ||
    !integer(item.generation) ||
    item.generation === 0 ||
    !integer(item.sequence) ||
    item.sequence === 0
  )
    return null;
  const archive = parseChatArchive(item.archive);
  return archive
    ? { generation: item.generation, sequence: item.sequence, archive }
    : null;
}
export function parseChatArchiveStatus(value: unknown): ChatArchiveStatus {
  const item = object(value, 'available,generation,savedSequence');
  return item &&
    typeof item.available === 'boolean' &&
    (!item.available || (integer(item.generation) && item.generation > 0)) &&
    integer(item.generation) &&
    integer(item.savedSequence)
    ? {
        available: item.available,
        generation: item.generation,
        savedSequence: item.savedSequence,
      }
    : unavailableChatArchive();
}
export function parseChatArchiveLoad(value: unknown): ChatArchiveLoad {
  const item = object(value, 'archive,available,generation,savedSequence');
  if (!item) return { ...unavailableChatArchive(), archive: null };
  const status = parseChatArchiveStatus({
    available: item.available,
    generation: item.generation,
    savedSequence: item.savedSequence,
  });
  const archive = item.archive === null ? null : parseChatArchive(item.archive);
  if (item.archive !== null && !archive)
    return { ...unavailableChatArchive(), archive: null };
  return { ...status, archive };
}

export interface ChatArchivePort {
  load(): Promise<ChatArchiveLoad>;
  save(request: ChatArchiveSave): Promise<ChatArchiveStatus>;
  status(): Promise<ChatArchiveStatus>;
}
