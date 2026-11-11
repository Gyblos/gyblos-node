// Performs one bounded interactive request to the local buyer, never retries or follows redirects.
import { LOCALHOST, PORTS, ROUTES, UNITS } from '@gyblos/config';
import { prepareBuyerConversation } from '@gyblos/core/buyer-conversation';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import {
  sessionApproval,
  type SessionApproval,
} from '@gyblos/node/session-accounting';
import type { ChatMessage } from '@gyblos/protocol/chat';
import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_STREAM,
  OFFER_PRICING_KINDS,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import {
  BUYER_EXECUTION_FIELD,
  BUYER_SELECTION_CODES,
  CHAT_INPUT_BYTES,
  CHAT_TURN_STATUSES,
  FREE_BUYER,
  FREE_BUYER_CODES,
  PAID_BUYER,
  PAID_BUYER_CODES,
  PAID_BUYER_HTTP_MS,
  PAID_VERDICTS,
} from './constants';

export interface ChatTurnOptions {
  model: string;
  maxTokens: number;
  prompt: string;
  history?: readonly ChatMessage[];
  paid?: boolean;
  automatic?: boolean;
  write: (text: string) => void;
  signal?: AbortSignal;
}
interface ChatAccounting {
  requestDigest?: string;
  code?: string;
  usage?: { input: number; output: number };
  payment?: {
    session?: SessionApproval;
    verdict: string;
    charged: string | null;
    refunded: string | null;
  };
}
type ChatTerminal = ChatAccounting & {
  status:
    typeof CHAT_TURN_STATUSES.COMPLETE | typeof CHAT_TURN_STATUSES.UNCERTAIN;
};
export type ChatTurnResult = ChatAccounting &
  (
    | { status: typeof CHAT_TURN_STATUSES.COMPLETE; text: string }
    | {
        status:
          | typeof CHAT_TURN_STATUSES.UNCERTAIN
          | typeof CHAT_TURN_STATUSES.REJECTED;
      }
  );
const SSE_FRAMING = { jsonExpansion: 6, envelopeBytes: 1024 } as const;
const BOUNDS = {
  // A delta may expand to six bytes per character in JSON and each event adds an SSE envelope.
  responseBytes:
    FREE_STREAM.totalBytes * SSE_FRAMING.jsonExpansion +
    FREE_STREAM.maxEvents * SSE_FRAMING.envelopeBytes,
  timeoutMs: PAID_BUYER_HTTP_MS + UNITS.millisecondsPerSecond,
} as const;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
const amount = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value));

function paymentResult(payment: Record<string, unknown>) {
  if (payment.verdict === SESSION_VERDICTS.APPROVED) {
    if (payment.chargedAtomic !== null || payment.refundedAtomic !== null)
      throw new Error('payment');
    return {
      verdict: SESSION_VERDICTS.APPROVED,
      charged: null,
      refunded: null,
      session: sessionApproval(payment.session),
    };
  }
  if (payment.session !== undefined) throw new Error('payment');
  if (
    !Object.values(PAID_VERDICTS).some((value) => value === payment.verdict) ||
    !amount(payment.chargedAtomic) ||
    !amount(payment.refundedAtomic)
  )
    throw new Error('payment');
  return {
    verdict: String(payment.verdict),
    charged: payment.chargedAtomic,
    refunded: payment.refundedAtomic,
  };
}

function errorResult(
  value: unknown,
): ChatAccounting & { status: typeof CHAT_TURN_STATUSES.UNCERTAIN } {
  const error = record(record(value)?.error);
  const result: ChatAccounting & {
    status: typeof CHAT_TURN_STATUSES.UNCERTAIN;
  } = { status: CHAT_TURN_STATUSES.UNCERTAIN };
  if (!error) return result;
  const codes = [
    ...Object.values(SESSION_CODES),
    ...Object.values(FREE_BUYER_CODES),
    ...Object.values(PAID_BUYER_CODES),
    ...Object.values(FREE_EXECUTION_CODES),
    ...Object.values(PAID_EXECUTION_CODES),
    ...Object.values(SELLER_SELECTION_CODES),
    ...Object.values(BUYER_SELECTION_CODES),
    ...Object.values(PAYMENT_ERROR_CODES),
  ];
  if (
    typeof error.code === 'string' &&
    codes.some((code) => code === error.code)
  )
    result.code = error.code;
  const payment = record(error[PAID_BUYER.paymentField]);
  if (payment) result.payment = paymentResult(payment);
  return result;
}

function completeResult(
  choice: Record<string, unknown>,
  body: Record<string, unknown>,
  options: Pick<ChatTurnOptions, 'paid' | 'automatic'>,
): ChatTerminal {
  const usage = record(body.usage);
  if (
    !Object.values(ENGINE_DONE_REASONS).some(
      (reason) => reason === choice.finish_reason,
    ) ||
    !usage ||
    !count(usage.prompt_tokens) ||
    !count(usage.completion_tokens)
  )
    throw new Error('usage');
  const terminal: ChatTerminal = {
    status: CHAT_TURN_STATUSES.COMPLETE,
    usage: { input: usage.prompt_tokens, output: usage.completion_tokens },
  };
  const payment = record(body[PAID_BUYER.paymentField]);
  if (options.automatic) {
    const route = body[BUYER_EXECUTION_FIELD];
    if (
      route !== OFFER_PRICING_KINDS.FREE &&
      route !== OFFER_PRICING_KINDS.PAID
    )
      throw new Error('route');
    if ((route === OFFER_PRICING_KINDS.PAID) !== Boolean(payment))
      throw new Error('payment');
  } else if (options.paid && !payment) throw new Error('payment');
  if (payment) {
    terminal.payment = paymentResult(payment);
    if (
      payment.verdict !== PAID_VERDICTS.SETTLED &&
      payment.verdict !== SESSION_VERDICTS.APPROVED
    )
      terminal.status = CHAT_TURN_STATUSES.UNCERTAIN;
  }
  return terminal;
}

async function readError(
  body: ReadableStream<Uint8Array>,
): Promise<ChatTurnResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > BOUNDS.responseBytes) throw new Error('bound');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    return errorResult(parsed);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function chatTurn(
  options: ChatTurnOptions,
  request: typeof fetch,
): Promise<ChatTurnResult> {
  const messages = prepareBuyerConversation(
    options.history ?? [],
    options.prompt,
    CHAT_INPUT_BYTES,
  );
  if (!messages) return { status: CHAT_TURN_STATUSES.REJECTED };
  const signal = AbortSignal.any([
    AbortSignal.timeout(BOUNDS.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  if (signal.aborted) return { status: CHAT_TURN_STATUSES.REJECTED };
  try {
    const response = await request(
      `http://${LOCALHOST}:${PORTS.buyerProxy}${ROUTES.inference}`,
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(options.paid || options.automatic
            ? { [PAID_BUYER.observationHeader]: PAID_BUYER.observationValue }
            : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          max_tokens: options.maxTokens,
          stream: true,
        }),
      },
    );
    if (!response.body) return { status: CHAT_TURN_STATUSES.UNCERTAIN };
    if (!response.ok) return await readError(response.body);
    if (
      !response.headers
        .get('content-type')
        ?.startsWith(FREE_BUYER.streamContentType)
    )
      return { status: CHAT_TURN_STATUSES.UNCERTAIN };
    return await readStream(response.body, options);
  } catch {
    return { status: CHAT_TURN_STATUSES.UNCERTAIN };
  }
}

function streamDigest(
  value: unknown,
  previous: string | undefined,
): string | undefined {
  if (value === undefined) return previous;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value) ||
    (previous !== undefined && previous !== value)
  )
    throw new Error('digest');
  return value;
}
function frameDigest(
  body: Record<string, unknown> | undefined,
  previous: string | undefined,
  paid: boolean | undefined,
  terminal: ChatTerminal | undefined,
) {
  const candidate = paid ? body?.[PAID_BUYER.requestDigestField] : undefined;
  if (candidate === undefined) return previous;
  if (
    terminal ||
    !body ||
    !Array.isArray(body.choices) ||
    body.choices.length !== 1
  )
    throw new Error('digest');
  const choice = record(body.choices[0]);
  const delta = record(choice?.delta);
  if (
    !choice ||
    !delta ||
    choice.finish_reason !== null ||
    typeof delta.content !== 'string' ||
    delta.content.length === 0
  )
    throw new Error('digest');
  return streamDigest(candidate, previous);
}
const uncertain = (requestDigest?: string): ChatTurnResult =>
  requestDigest
    ? { status: CHAT_TURN_STATUSES.UNCERTAIN, requestDigest }
    : { status: CHAT_TURN_STATUSES.UNCERTAIN };

function writeDelta(options: ChatTurnOptions, value: unknown) {
  if (typeof value === 'string')
    options.write(value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  options: ChatTurnOptions,
): Promise<ChatTurnResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let bytes = 0;
  let done = false;
  let terminal: ChatTerminal | undefined;
  let text = '';
  let contentBytes = 0;
  let requestDigest: string | undefined;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > BOUNDS.responseBytes) throw new Error('bound');
      pending += decoder.decode(item.value, { stream: true });
      let end = pending.indexOf('\n\n');
      while (end >= 0) {
        const event = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (!event.startsWith('data: ') || done) throw new Error('frame');
        const data = event.slice('data: '.length);
        if (data === FREE_BUYER.streamDone) {
          if (!terminal) throw new Error('terminal');
          done = true;
        } else {
          const value: unknown = JSON.parse(data);
          const body = record(value);
          try {
            requestDigest = frameDigest(
              body,
              requestDigest,
              options.paid || options.automatic,
              terminal,
            );
          } catch {
            requestDigest = undefined;
            throw new Error('digest');
          }
          if (
            !body ||
            terminal ||
            !Array.isArray(body.choices) ||
            body.choices.length !== 1
          ) {
            if (body?.error && !terminal) {
              terminal = errorResult(body);
              done = true;
              end = pending.indexOf('\n\n');
              continue;
            }
            throw new Error('event');
          }
          const choice = record(body.choices[0]);
          const delta = record(choice?.delta);
          if (!choice || !delta) throw new Error('choice');
          if (delta.content !== undefined) {
            if (
              typeof delta.content !== 'string' ||
              /[\uD800-\uDFFF]/u.test(delta.content)
            )
              throw new Error('content');
            contentBytes += Buffer.byteLength(delta.content);
            if (contentBytes > FREE_EXECUTION.outputBytes)
              throw new Error('bound');
            text += delta.content;
          }
          writeDelta(options, delta.content);
          if (choice.finish_reason !== null) {
            terminal = completeResult(choice, body, options);
          }
        }
        end = pending.indexOf('\n\n');
      }
    }
    pending += decoder.decode();
    if (!done || pending || !terminal) return uncertain(requestDigest);
    if (terminal.status === CHAT_TURN_STATUSES.COMPLETE)
      return { ...terminal, status: CHAT_TURN_STATUSES.COMPLETE, text };
    return requestDigest
      ? { ...terminal, status: CHAT_TURN_STATUSES.UNCERTAIN, requestDigest }
      : { ...terminal, status: CHAT_TURN_STATUSES.UNCERTAIN };
  } catch {
    return uncertain(requestDigest);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
