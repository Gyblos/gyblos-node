// Pure conversation transitions for the desktop preview, independent of React/timers.
// Never makes inference, tool, payment or persistence calls.
import {
  CHAT_PHASE,
  CHAT_PREVIEW,
  CHAT_ROLE,
  MESSAGE_STATE,
} from './constants';
import type { DemoAuthorizationStatus } from './demo-account';
import type { ChatModel } from './model-types';
import type { ToolId } from './tools';

export type { ChatModel } from './model-types';

export { CHAT_PHASE, MESSAGE_STATE } from './constants';

export type ChatPhase = (typeof CHAT_PHASE)[keyof typeof CHAT_PHASE];
export type MessageState = (typeof MESSAGE_STATE)[keyof typeof MESSAGE_STATE];
export type ChatMessage = {
  id: string;
  role: (typeof CHAT_ROLE)[keyof typeof CHAT_ROLE];
  text: string;
  model: ChatModel;
  state: MessageState;
  tools: ToolId[];
};
export type ChatRun = {
  id: string;
  phase: ChatPhase;
  model: ChatModel;
  tools: ToolId[];
  reply: string;
  offset: number;
};
export type ChatSession = {
  id: string;
  title: string;
  draft: string;
  notice: string;
  blocked: DemoAuthorizationStatus | null;
  messages: ChatMessage[];
  run: ChatRun | null;
};
export function createSession(id: string): ChatSession {
  return {
    id,
    title: 'New conversation',
    draft: '',
    notice: '',
    blocked: null,
    messages: [],
    run: null,
  };
}
export function sampleReply(prompt: string, tools: readonly ToolId[]) {
  if (tools.length)
    return '## A clear path forward\n\nStart with the question, gather the relevant context, then turn it into a useful answer.\n\n- Use the enabled tools to gather context.\n- Keep track of the sources used.\n- Ask before expanding the task.\n\nWe can work through the task step by step and review the result together.';
  if (/code|build|program|project|codigo|código/i.test(prompt))
    return '## Start with something small\n\nGive the first version one clear responsibility. Keep the input and output explicit, then add complexity when it earns its place.\n\n```typescript\nfunction greeting(name: string): string {\n  return `Hello, ${name}.`;\n}\n```\n\n- Define what success looks like.\n- Build the smallest useful step.\n- Check the result before expanding.\n\nWhat would you like that first version to do?';
  return '## Let’s make it concrete\n\nA useful answer starts with the question behind the question. We can work through it one piece at a time.\n\n- **What do you know?** Start with one concrete example.\n- **What is uncertain?** Separate evidence from assumptions.\n- **What can you try?** Choose one small, reversible next step.\n\nChange a single assumption and look at what happens. That often reveals more than trying to solve the whole problem at once.\n\nWhich part would you like to explore first?';
}
export function startRun(
  session: ChatSession,
  prompt: string,
  model: ChatModel,
  tools: ToolId[],
  id: string,
): ChatSession {
  if (session.run || !prompt.trim()) return session;
  const text = prompt.trim();
  return {
    ...session,
    draft: '',
    title: session.messages.length
      ? session.title
      : text.slice(0, CHAT_PREVIEW.TITLE_LENGTH),
    messages: [
      ...session.messages,
      {
        id: `${id}-user`,
        role: CHAT_ROLE.USER,
        text,
        model: { ...model },
        state: MESSAGE_STATE.COMPLETE,
        tools: [],
      },
      {
        id: `${id}-assistant`,
        role: CHAT_ROLE.ASSISTANT,
        text: '',
        model: { ...model },
        state: MESSAGE_STATE.PENDING,
        tools: [...tools],
      },
    ],
    run: {
      id,
      phase: CHAT_PHASE.CONNECTING,
      model: { ...model },
      tools: [...tools],
      reply: sampleReply(text, tools),
      offset: 0,
    },
  };
}
export function advanceRun(session: ChatSession, id: string): ChatSession {
  const run = session.run;
  if (!run || run.id !== id) return session;
  if (run.phase === CHAT_PHASE.CONNECTING)
    return {
      ...session,
      run: {
        ...run,
        phase: run.tools.length ? CHAT_PHASE.TOOLS : CHAT_PHASE.RESPONDING,
      },
    };
  if (run.phase === CHAT_PHASE.TOOLS)
    return { ...session, run: { ...run, phase: CHAT_PHASE.RESPONDING } };
  const offset = Math.min(
    run.reply.length,
    run.offset + CHAT_PREVIEW.STREAM_CHUNK,
  );
  const complete = offset === run.reply.length;
  return {
    ...session,
    messages: session.messages.map((message) =>
      message.id === `${id}-assistant`
        ? {
            ...message,
            text: run.reply.slice(0, offset),
            state: complete ? MESSAGE_STATE.COMPLETE : MESSAGE_STATE.PENDING,
          }
        : message,
    ),
    run: complete ? null : { ...run, offset },
  };
}
export function stopRun(session: ChatSession): ChatSession {
  if (!session.run) return session;
  const id = `${session.run.id}-assistant`;
  return {
    ...session,
    run: null,
    messages: session.messages.map((message) =>
      message.id === id
        ? { ...message, state: MESSAGE_STATE.STOPPED }
        : message,
    ),
  };
}

export function toggleToolSelection(
  selected: readonly ToolId[],
  connected: readonly ToolId[],
  id: ToolId,
): ToolId[] {
  const enabled = selected.filter((item) => connected.includes(item));
  return enabled.includes(id)
    ? enabled.filter((item) => item !== id)
    : [...enabled, id];
}
