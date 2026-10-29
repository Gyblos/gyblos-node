// In-memory OpenAI-compatible provider: deterministic usage and cancellable SSE; no network, API key or content logs.
import { HTTP_STATUS } from '@gyblos/config';

import { acceptanceAssert } from './errors';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';

export function createReceiptProvider() {
  let calls = 0;
  let cancellations = 0;
  let fail = false;
  let hold = false;
  let release = () => {};
  const encoder = new TextEncoder();
  const frame = (value: unknown) =>
    encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  return {
    calls: () => calls,
    cancellations: () => cancellations,
    setFailure: (value: boolean) => {
      fail = value;
    },
    hold: () => {
      hold = true;
    },
    release: () => release(),
    async request(request: Request) {
      const url = new URL(request.url);
      acceptanceAssert(!request.headers.has('authorization'));
      acceptanceAssert(url.origin === RECEIPT_ACCEPTANCE.engineOrigin);
      if (request.method === 'GET' && url.pathname === '/v1/models')
        return Response.json({ data: [{ id: RECEIPT_ACCEPTANCE.modelId }] });
      acceptanceAssert(
        request.method === 'POST' && url.pathname === '/v1/chat/completions',
      );
      calls++;
      if (fail)
        return new Response(null, { status: HTTP_STATUS.serviceUnavailable });
      const blocked = hold;
      hold = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            let ended = false;
            const cancel = () => {
              if (ended) return;
              ended = true;
              cancellations++;
              controller.error(new Error('Synthetic cancellation'));
            };
            const complete = () => {
              if (ended) return;
              ended = true;
              request.signal.removeEventListener('abort', cancel);
              controller.enqueue(
                frame({
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                }),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            };
            release = complete;
            request.signal.addEventListener('abort', cancel, { once: true });
            if (request.signal.aborted) {
              cancel();
              return;
            }
            controller.enqueue(
              frame({
                choices: [
                  {
                    delta: { content: RECEIPT_ACCEPTANCE.text },
                    finish_reason: null,
                  },
                ],
              }),
            );
            if (!blocked) complete();
          },
          cancel() {
            cancellations++;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  };
}
export type ReceiptProvider = ReturnType<typeof createReceiptProvider>;
