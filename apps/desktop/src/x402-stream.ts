// Reads the local buyer's bounded text-only SSE subset; deltas never establish payment or completion.
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  AGENT_CHAT,
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';

import { reportedUsage } from './response-metrics';
import { DESKTOP_X402, DESKTOP_X402_STREAM } from './x402/constants';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid buyer stream');
  return value as Record<string, unknown>;
}
interface StreamState {
  id?: string;
  created?: number;
  text: string;
  textBytes: number;
  events: number;
  done: boolean;
  terminal?: Record<string, unknown>;
}
function hasExecution(value: Record<string, unknown>) {
  const kind = value[BUYER_API.EXECUTION_FIELD];
  // The existing paid-only endpoint omits this marker. Its payment still requires
  // the complete parseBuyerReply checks before any permission is completed.
  return kind === undefined
    ? value[BUYER_API.PAYMENT_FIELD] !== undefined
    : Object.values(OFFER_PRICING_KINDS).some((entry) => entry === kind);
}
function streamFrame(
  state: StreamState,
  data: string,
  policy: BuyerApiPolicy,
  onDelta: (text: string) => void,
) {
  if (state.done || ++state.events > DESKTOP_X402_STREAM.maxEvents)
    throw new Error('Invalid buyer stream');
  if (data === AGENT_CHAT.STREAM_DONE) {
    if (!state.terminal) throw new Error('Incomplete buyer stream');
    state.done = true;
    return;
  }
  if (state.terminal) throw new Error('Invalid buyer stream');
  const value = object(JSON.parse(data));
  if (
    value.object !== AGENT_CHAT.CHUNK ||
    value.model !== policy.model ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > DESKTOP_X402.MAX_ID ||
    typeof value.created !== 'number' ||
    !Number.isSafeInteger(value.created) ||
    value.created < 0 ||
    (state.id !== undefined && value.id !== state.id) ||
    (state.created !== undefined && value.created !== state.created) ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    throw new Error('Invalid buyer stream');
  state.id = value.id;
  state.created = value.created;
  const choice = object(value.choices[0]);
  const delta = object(choice.delta);
  if (
    choice.index !== 0 ||
    Object.keys(delta).some((key) => key !== 'content' && key !== 'role') ||
    (delta.role !== undefined && delta.role !== FREE_CHAT_ROLES.ASSISTANT)
  )
    throw new Error('Invalid buyer stream');
  if (choice.finish_reason !== null) {
    if (
      Object.keys(delta).length ||
      (choice.finish_reason !== ENGINE_DONE_REASONS.STOP &&
        choice.finish_reason !== ENGINE_DONE_REASONS.LENGTH) ||
      !reportedUsage(value.usage, policy.maxTokens) ||
      !hasExecution(value)
    )
      throw new Error('Incomplete buyer stream');
    state.terminal = {
      model: policy.model,
      choices: [
        {
          message: { role: FREE_CHAT_ROLES.ASSISTANT, content: state.text },
          finish_reason: choice.finish_reason,
        },
      ],
      usage: value.usage,
      [BUYER_API.EXECUTION_FIELD]: value[BUYER_API.EXECUTION_FIELD],
      [BUYER_API.PAYMENT_FIELD]: value[BUYER_API.PAYMENT_FIELD],
    };
    return;
  }
  if (typeof delta.content !== 'string') {
    if (delta.role === FREE_CHAT_ROLES.ASSISTANT && delta.content === undefined)
      return;
    throw new Error('Invalid buyer stream');
  }
  state.textBytes += Buffer.byteLength(delta.content);
  if (state.textBytes > DESKTOP_X402.MAX_RESPONSE)
    throw new Error('Buyer response is too large');
  state.text += delta.content;
  if (delta.content) onDelta(delta.content);
}
export async function readBuyerStream(
  response: Response,
  policy: BuyerApiPolicy,
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<unknown> {
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0]?.trim() !==
      'text/event-stream'
  )
    throw new Error('Buyer streaming is unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const state: StreamState = { text: '', textBytes: 0, events: 0, done: false };
  let pending = '';
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > DESKTOP_X402_STREAM.wireBytes)
        throw new Error('Buyer response is too large');
      pending += decoder.decode(item.value, { stream: true });
      let end = pending.indexOf('\n\n');
      while (end >= 0) {
        const event = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (
          !event.startsWith('data: ') ||
          Buffer.byteLength(event) > DESKTOP_X402_STREAM.frameBytes
        )
          throw new Error('Invalid buyer stream');
        signal.throwIfAborted();
        streamFrame(state, event.slice('data: '.length), policy, onDelta);
        end = pending.indexOf('\n\n');
      }
      if (Buffer.byteLength(pending) > DESKTOP_X402_STREAM.frameBytes)
        throw new Error('Buyer response is too large');
    }
    pending += decoder.decode();
    signal.throwIfAborted();
    if (pending || !state.done || !state.terminal)
      throw new Error('Incomplete buyer stream');
    return state.terminal;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
