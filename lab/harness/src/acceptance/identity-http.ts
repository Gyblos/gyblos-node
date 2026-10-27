// Verifies early product SSE delivery and cancellation without reporting response content.
// HTTP targets are allocated loopback addresses only; the engine remains synthetic.
import { request, type IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { FREE_BUYER } from '@gyblos/buyer/constants';
import { HTTP_STATUS } from '@gyblos/config';
import { FREE_CHAT_ROLES, MODEL_IDS } from '@gyblos/protocol/constants';

import { ACCEPTANCE } from './constants.js';
import { acceptanceAssert } from './errors.js';
import type { FreeAcceptanceBuyer } from './free-buyer.js';
import { FREE_ACCEPTANCE, FREE_STREAM_ACCEPTANCE } from './free-constants.js';
import type { IdentityAcceptanceContext } from './identity-context.js';

async function firstDelta(buyer: FreeAcceptanceBuyer, signal: AbortSignal) {
  acceptanceAssert(
    new URL(buyer.url).origin.startsWith(`${ACCEPTANCE.origin}:`),
  );
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      buyer.url,
      {
        method: 'POST',
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(ACCEPTANCE.queryMs),
        ]),
        headers: { 'content-type': FREE_BUYER.contentType },
      },
      resolve,
    );
    outgoing.on('error', reject);
    outgoing.end(
      JSON.stringify({
        model: MODEL_IDS.QWEN3_0_6B,
        messages: [
          { role: FREE_CHAT_ROLES.USER, content: 'synthetic acceptance input' },
        ],
        max_tokens: FREE_ACCEPTANCE.maxTokens,
        stream: true,
      }),
    );
  });
  try {
    acceptanceAssert(response.statusCode === HTTP_STATUS.ok);
    acceptanceAssert(
      response.headers['content-type'] === FREE_BUYER.streamContentType,
    );
    acceptanceAssert(response.headers[FREE_BUYER.noRetryHeader] === 'false');
    const reader = response[Symbol.asyncIterator]();
    const first = await reader.next();
    const text = String(first.value);
    acceptanceAssert(
      text.includes('"content":"syn"') && !text.includes(FREE_BUYER.streamDone),
    );
    return { response, reader, text };
  } catch (error) {
    response.destroy();
    throw error;
  }
}
export async function identityStreamAnswer(
  context: IdentityAcceptanceContext,
  buyer: FreeAcceptanceBuyer,
) {
  const release = context.run.engine.holdAfterText();
  let stream: Awaited<ReturnType<typeof firstDelta>> | undefined;
  try {
    stream = await firstDelta(buyer, context.signal);
    release();
    let text = stream.text;
    for (;;) {
      const part = await stream.reader.next();
      if (part.done) break;
      text += String(part.value);
      acceptanceAssert(
        Buffer.byteLength(text) <= FREE_ACCEPTANCE.httpResponseBytes,
      );
    }
    acceptanceAssert(
      text.includes('"content":"thetic"') &&
        text.includes('"finish_reason":"stop"') &&
        text.includes('"total_tokens":2') &&
        text.includes(`data: ${FREE_BUYER.streamDone}`),
    );
    context.answers++;
  } finally {
    release();
    stream?.response.destroy();
  }
}
export async function identityStreamCancellation(
  context: IdentityAcceptanceContext,
  buyer: FreeAcceptanceBuyer,
) {
  const before = context.run.engine.cancellations();
  const dials = buyer.dials.length;
  const release = context.run.engine.holdAfterText();
  let stream: Awaited<ReturnType<typeof firstDelta>> | undefined;
  try {
    stream = await firstDelta(buyer, context.signal);
    stream.response.destroy();
    for (
      let attempt = 0;
      attempt < FREE_STREAM_ACCEPTANCE.cancelPollAttempts &&
      context.run.engine.cancellations() === before;
      attempt++
    )
      await delay(FREE_STREAM_ACCEPTANCE.cancelPollMs, undefined, {
        signal: context.signal,
      });
    acceptanceAssert(
      context.run.engine.cancellations() === before + 1 &&
        buyer.dials.length === dials + 1,
    );
  } finally {
    release();
    stream?.response.destroy();
  }
}
