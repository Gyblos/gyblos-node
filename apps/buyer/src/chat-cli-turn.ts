// Performs one bounded interactive request to the local buyer, never retries or follows redirects.
import { LOCALHOST, PORTS, ROUTES, UNITS } from '@gyblos/config';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';

import {
  FREE_BUYER,
  PAID_BUYER,
  PAID_BUYER_HTTP_MS,
  PAID_VERDICTS,
} from './constants';

export interface ChatTurnOptions {
  model: string;
  maxTokens: number;
  prompt: string;
  token?: string;
  write: (text: string) => void;
  signal?: AbortSignal;
}
export interface ChatTurnResult {
  status: 'complete' | 'uncertain' | 'rejected';
  usage?: { input: number; output: number };
  payment?: {
    verdict: string;
    charged: string | null;
    refunded: string | null;
  };
}
const BOUNDS = {
  promptBytes: 64_000,
  responseBytes: 1_048_576,
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

export async function chatTurn(
  options: ChatTurnOptions,
  request: typeof fetch = fetch,
): Promise<ChatTurnResult> {
  if (
    !options.prompt.trim() ||
    Buffer.byteLength(options.prompt) > BOUNDS.promptBytes
  )
    return { status: 'rejected' };
  const signal = AbortSignal.any([
    AbortSignal.timeout(BOUNDS.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  if (signal.aborted) return { status: 'rejected' };
  try {
    const response = await request(
      `http://${LOCALHOST}:${PORTS.buyerProxy}${ROUTES.inference}`,
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(options.token
            ? { authorization: `${PAID_BUYER.authScheme} ${options.token}` }
            : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: FREE_CHAT_ROLES.USER, content: options.prompt }],
          max_tokens: options.maxTokens,
          stream: true,
        }),
      },
    );
    if (
      !response.ok ||
      !response.body ||
      !response.headers
        .get('content-type')
        ?.startsWith(FREE_BUYER.streamContentType)
    )
      return { status: 'uncertain' };
    return await readStream(response.body, options);
  } catch {
    return { status: 'uncertain' };
  }
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
  let terminal: ChatTurnResult | undefined;
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
          if (
            !body ||
            body.error ||
            terminal ||
            !Array.isArray(body.choices) ||
            body.choices.length !== 1
          )
            throw new Error('event');
          const choice = record(body.choices[0]);
          const delta = record(choice?.delta);
          if (!choice || !delta) throw new Error('choice');
          if (typeof delta.content === 'string')
            options.write(
              delta.content.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''),
            );
          if (choice.finish_reason !== null) {
            const usage = record(body.usage);
            if (
              typeof choice.finish_reason !== 'string' ||
              !usage ||
              !count(usage.prompt_tokens) ||
              !count(usage.completion_tokens)
            )
              throw new Error('usage');
            terminal = {
              status: 'complete',
              usage: {
                input: usage.prompt_tokens,
                output: usage.completion_tokens,
              },
            };
            const payment = record(body[PAID_BUYER.paymentField]);
            if (options.token && !payment) throw new Error('payment');
            if (payment) {
              terminal.payment = paymentResult(payment);
              if (payment.verdict !== PAID_VERDICTS.SETTLED)
                terminal.status = 'uncertain';
            }
          }
        }
        end = pending.indexOf('\n\n');
      }
    }
    pending += decoder.decode();
    if (!done || pending || !terminal) return { status: 'uncertain' };
    return terminal;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
