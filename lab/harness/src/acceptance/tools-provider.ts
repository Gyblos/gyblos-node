// Scripted OpenAI SSE provider used behind the real adapter; never executes tools or records request bodies.
import { isDeepStrictEqual } from 'node:util';

import { acceptanceAssert } from './errors';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';
import { createReceiptProvider } from './receipt-provider';
import {
  TOOL_ACCEPTANCE,
  TOOL_ACCEPTANCE_CASES,
  type ToolAcceptanceCase,
} from './tools-constants';
import { providerExpectation, TOOL_FIXTURE } from './tools-fixtures';

export function createToolProvider(scenario: ToolAcceptanceCase) {
  const base = createReceiptProvider();
  let calls = 0;
  let cancellations = 0;
  let verifiedTurns = 0;
  let release = () => {};
  const encoder = new TextEncoder();
  const frame = (value: unknown) =>
    encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  return {
    ...base,
    calls: () => calls,
    cancellations: () => cancellations,
    verifiedTurns: () => verifiedTurns,
    release: () => release(),
    async request(request: Request) {
      if (request.method === 'GET') return base.request(request);
      acceptanceAssert(
        new URL(request.url).origin === RECEIPT_ACCEPTANCE.engineOrigin,
      );
      acceptanceAssert(!request.headers.has('authorization'));
      const value: unknown = await request.json();
      acceptanceAssert(
        isDeepStrictEqual(value, providerExpectation(calls === 1)),
      );
      calls++;
      verifiedTurns++;
      const followup = calls === 2;
      const holding = scenario === TOOL_ACCEPTANCE_CASES.CANCEL;
      let cancelStream = () => {};
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            let ended = false;
            const cleanup = () =>
              request.signal.removeEventListener('abort', cancel);
            const cancel = () => {
              if (ended) return;
              ended = true;
              cancellations++;
              cleanup();
              controller.error(new Error('Synthetic cancellation'));
            };
            cancelStream = cancel;
            const complete = () => {
              if (ended) return;
              ended = true;
              cleanup();
              controller.enqueue(
                frame({
                  choices: [
                    {
                      delta: {},
                      finish_reason: followup ? 'stop' : 'tool_calls',
                    },
                  ],
                  usage: {
                    prompt_tokens: TOOL_ACCEPTANCE.inputTokens,
                    completion_tokens: TOOL_ACCEPTANCE.outputTokens,
                  },
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
                    delta: followup
                      ? { content: TOOL_FIXTURE.final }
                      : {
                          tool_calls: [
                            {
                              index: 0,
                              id: TOOL_FIXTURE.id,
                              type: 'function',
                              function: {
                                name:
                                  scenario === TOOL_ACCEPTANCE_CASES.PROVIDER
                                    ? 'unoffered_tool'
                                    : TOOL_FIXTURE.name,
                                arguments: TOOL_FIXTURE.arguments,
                              },
                            },
                          ],
                        },
                    finish_reason: null,
                  },
                ],
              }),
            );
            if (scenario === TOOL_ACCEPTANCE_CASES.CUT) {
              ended = true;
              cleanup();
              controller.error(new Error('Synthetic interrupted terminal'));
            } else if (!holding) complete();
          },
          cancel() {
            cancelStream();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  };
}
