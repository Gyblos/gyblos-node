// Synthetic desktop response fixtures; no operational identities, wallets, providers or sockets.
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import { AGENT_CHAT, OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

export const policy: BuyerApiPolicy = {
  version: 1,
  policyId: '00000000-0000-4000-8000-000000000001',
  model: 'synthetic',
  maxTokens: 128,
  maxAtomic: '0',
  network: DEVNET,
  mint: DEVNET_USDC,
  payer: '11111111111111111111111111111111',
};
export function latch() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export function chunk(content: string, terminal = false) {
  return {
    id: 'chatcmpl-synthetic',
    object: AGENT_CHAT.CHUNK,
    created: 1,
    model: policy.model,
    choices: [
      {
        index: 0,
        delta: terminal ? {} : { content },
        finish_reason: terminal ? 'stop' : null,
      },
    ],
    ...(terminal
      ? {
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          [BUYER_API.EXECUTION_FIELD]: OFFER_PRICING_KINDS.FREE,
        }
      : {}),
  };
}
export const frame = (value: unknown) =>
  new TextEncoder().encode('data: ' + JSON.stringify(value) + '\n\n');
export function setup(maxAtomic = '0') {
  let saved: string | undefined;
  const files = {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
  const budget = new X402Budget(files);
  const posted = latch();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let request: RequestInit | undefined;
  let posts = 0;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const client = new X402Client(budget, async (_url, options) => {
    if (options?.method !== 'POST')
      return Response.json({ ...policy, maxAtomic });
    posts++;
    request = options;
    options.signal?.addEventListener(
      'abort',
      () => controller.error(new DOMException('Stopped', 'AbortError')),
      { once: true },
    );
    controller.enqueue(frame(chunk('Hello')));
    posted.resolve();
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return {
    client,
    budget,
    files,
    posted,
    request: () => request,
    posts: () => posts,
    finish() {
      try {
        controller.enqueue(frame(chunk('', true)));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      } catch {
        /* The cancellation path already closed the synthetic body. */
      }
    },
  };
}
export async function connect(
  value: ReturnType<typeof setup>,
  maxAtomic = '0',
) {
  await value.client.connect(
    'http://127.0.0.1:8090/v1/chat/completions',
    'synthetic-local-buyer-token',
  );
  await value.client.authorize(maxAtomic);
}
