// Verifies real discovery/selection/native streaming through the product buyer HTTP endpoint.
// Synthetic content remains in memory; only counters/booleans are returned, never endpoints or content.
import { request, type IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { FREE_BUYER } from '@gyblos/buyer/constants';
import { HTTP_STATUS } from '@gyblos/config';
import { FREE_CHAT_ROLES, MODEL_IDS } from '@gyblos/protocol/constants';

import { ACCEPTANCE, ACCEPTANCE_CODES, ACCEPTANCE_INDEX } from './constants.js';
import {
  acceptanceAssert,
  AcceptanceError,
  assertAcceptanceActive,
} from './errors.js';
import { createFreeBuyer, type FreeAcceptanceBuyer } from './free-buyer.js';
import { FREE_ACCEPTANCE, FREE_STREAM_ACCEPTANCE } from './free-constants.js';
import { createFreeSeller } from './free-session.js';
import { pump } from './phases.js';

function openStream(url: string, signal: AbortSignal) {
  const address = new URL(url);
  acceptanceAssert(address.origin.startsWith(`${ACCEPTANCE.origin}:`));
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: 'POST',
        signal,
        headers: { 'content-type': FREE_BUYER.contentType },
      },
      resolve,
    );
    outgoing.on('error', () =>
      reject(new AcceptanceError(ACCEPTANCE_CODES.FAILED)),
    );
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
}
async function firstDelta(buyer: FreeAcceptanceBuyer, signal: AbortSignal) {
  const response = await openStream(buyer.url, signal);
  acceptanceAssert(response.statusCode === HTTP_STATUS.ok);
  acceptanceAssert(
    response.headers['content-type'] === FREE_BUYER.streamContentType,
  );
  acceptanceAssert(response.headers[FREE_BUYER.noRetryHeader] === 'false');
  const reader = response[Symbol.asyncIterator]();
  const initial = await reader.next();
  const text = String(initial.value);
  acceptanceAssert(
    text.includes('"content":"syn"') && !text.includes(FREE_BUYER.streamDone),
  );
  return { response, reader, text };
}
export async function runFreeStreamAcceptance(
  options: { signal?: AbortSignal } = {},
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(FREE_ACCEPTANCE.maxRunMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  assertAcceptanceActive(signal);
  const run = await createFreeSeller(signal);
  let buyer: FreeAcceptanceBuyer | undefined;
  try {
    acceptanceAssert(await run.host().publisher.tick());
    buyer = await createFreeBuyer(run);
    let release = run.engine.holdAfterText();
    try {
      const streaming = await firstDelta(buyer, signal);
      release();
      let text = streaming.text;
      for (;;) {
        const part = await streaming.reader.next();
        if (part.done) break;
        text += String(part.value);
        acceptanceAssert(
          Buffer.byteLength(text) <= FREE_ACCEPTANCE.httpResponseBytes,
        );
      }
      acceptanceAssert(text.includes('"content":"thetic"'));
      acceptanceAssert(text.includes('"finish_reason":"stop"'));
      acceptanceAssert(text.includes('"total_tokens":2'));
      acceptanceAssert(text.includes(`data: ${FREE_BUYER.streamDone}`));
    } finally {
      release();
    }
    await pump(run, 1);
    const before = run.engine.cancellations();
    release = run.engine.holdAfterText();
    try {
      const streaming = await firstDelta(buyer, signal);
      streaming.response.destroy();
      for (
        let attempt = 0;
        attempt < FREE_STREAM_ACCEPTANCE.cancelPollAttempts &&
        run.engine.cancellations() === before;
        attempt++
      )
        await delay(FREE_STREAM_ACCEPTANCE.cancelPollMs, undefined, { signal });
      acceptanceAssert(run.engine.cancellations() === before + 1);
      acceptanceAssert(buyer.selections() === 2 && buyer.dials.length === 2);
    } finally {
      release();
    }
    acceptanceAssert(
      buyer.queryEngineAttempts() === 0 && buyer.queryGenerations() === 0,
    );
    return {
      ok: true,
      nativeIroh: true,
      index: ACCEPTANCE_INDEX,
      paymentsEnabled: false,
      answers: 1,
      cancellations: 1,
      noRetry: true,
      queryEngineAttempts: buyer.queryEngineAttempts(),
    };
  } catch (error) {
    assertAcceptanceActive(signal);
    throw error;
  } finally {
    try {
      await buyer?.close();
    } finally {
      await run.close();
    }
  }
}
