// Proves typed execution refusals over native Iroh, including guards that a normal client rejects locally.
// Each refusal asserts that synthetic engine generation did not increase.
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';

import { acceptanceAssert } from './errors';
import { FREE_ACCEPTANCE } from './free-constants';
import {
  acquireFreeQuote,
  executeFreeQuote,
  expectFreeRefusal,
  rawFreeQuote,
} from './free-quotes';
import { createFreeSeller } from './free-session';
import { createAcceptanceBuyerEndpoint } from './native';
import { pump } from './phases';
import type { AcceptanceSession } from './session';

export async function executionReplay(run: AcceptanceSession) {
  const quoted = await acquireFreeQuote(run);
  try {
    const before = run.engine.generations();
    const result = await executeFreeQuote(run, quoted.endpoint, quoted.request);
    acceptanceAssert(
      result.usage.inputTokens === 1 && result.usage.outputTokens === 1,
    );
    acceptanceAssert(run.engine.generations() === before + 1);
    await expectFreeRefusal(run, FREE_EXECUTION_CODES.REPLAY, () =>
      executeFreeQuote(run, quoted.endpoint, quoted.request),
    );
  } finally {
    await quoted.close();
  }
  await pump(run, 1);
}
export async function expiredQuote(run: AcceptanceSession) {
  const quoted = await acquireFreeQuote(run);
  try {
    await run.clock.advance(
      quoted.request.quote.offer.expiresAt - run.clock.now(),
    );
    await expectFreeRefusal(run, FREE_EXECUTION_CODES.EXPIRED, () =>
      rawFreeQuote(run, quoted.endpoint, quoted.request),
    );
  } finally {
    await quoted.close();
  }
  await pump(run, 1);
}
export async function wrongPeer(run: AcceptanceSession) {
  const quoted = await acquireFreeQuote(run);
  const other = await createAcceptanceBuyerEndpoint();
  try {
    await expectFreeRefusal(run, FREE_EXECUTION_CODES.PEER, () =>
      rawFreeQuote(run, other, quoted.request),
    );
  } finally {
    await other.close();
    await quoted.close();
  }
}
export async function engineDown(run: AcceptanceSession) {
  const quoted = await acquireFreeQuote(run);
  run.engine.fail(true);
  const attempts = run.engine.attempts();
  try {
    await expectFreeRefusal(run, FREE_EXECUTION_CODES.ENGINE, () =>
      executeFreeQuote(run, quoted.endpoint, quoted.request),
    );
    acceptanceAssert(run.engine.attempts() === attempts + 1);
  } finally {
    run.engine.fail(false);
    await quoted.close();
  }
  await pump(run, 1);
}
export async function capsExhausted(signal: AbortSignal) {
  const run = await createFreeSeller(signal, undefined, true);
  let first: Awaited<ReturnType<typeof acquireFreeQuote>> | undefined;
  try {
    first = await acquireFreeQuote(run);
    await executeFreeQuote(run, first.endpoint, first.request);
    await pump(run, 1);
    const repeated = await acquireFreeQuote(run, first.endpoint);
    await expectFreeRefusal(run, FREE_EXECUTION_CODES.BUYER_CAP, () =>
      executeFreeQuote(run, repeated.endpoint, repeated.request),
    );
    const second = await acquireFreeQuote(run);
    try {
      await executeFreeQuote(run, second.endpoint, second.request);
      await pump(run, 1);
    } finally {
      await second.close();
    }
    const third = await acquireFreeQuote(run);
    try {
      await expectFreeRefusal(run, FREE_EXECUTION_CODES.DAILY_CAP, () =>
        executeFreeQuote(run, third.endpoint, third.request),
      );
    } finally {
      await third.close();
    }
    acceptanceAssert(
      FREE_ACCEPTANCE.limitedDailyCap > FREE_ACCEPTANCE.limitedBuyerCap,
    );
  } finally {
    await first?.close();
    await run.close();
  }
}
