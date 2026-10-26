// Runs full synthetic free acceptance while preserving the existing control-only/opt-in engine scenario.
// Reports fixed case IDs and counters only; product/real-engine/paid startup and external publication are absent.
import { SELLER_READINESS } from '@gyblos/config';
import { OFFER_LIFETIME_MS } from '@gyblos/core/constants';
import { FREE_EXECUTION_CODES, GYBLOS_ALPN } from '@gyblos/protocol/constants';
import { HTTP_OVER_IROH } from '@gyblos/transport-iroh/constants';
import { controlDeadline } from '@gyblos/transport-iroh/control-io';

import { acceptQuote } from './buyer.js';
import {
  ACCEPTANCE,
  ACCEPTANCE_CLOCKS,
  ACCEPTANCE_INDEX,
  ACCEPTANCE_MODES,
} from './constants.js';
import { acceptanceAssert, assertAcceptanceActive } from './errors.js';
import { createFreeBuyer, type FreeAcceptanceBuyer } from './free-buyer.js';
import {
  FREE_ACCEPTANCE,
  FREE_ACCEPTANCE_CASES,
  type FreeAcceptanceCase,
} from './free-constants.js';
import { failoverCases } from './free-failover.js';
import {
  capsExhausted,
  engineDown,
  executionReplay,
  expiredQuote,
  wrongPeer,
} from './free-negative.js';
import { freeAvailability } from './free-phases.js';
import {
  acquireFreeQuote,
  expectFreeRefusal,
  rawFreeQuote,
} from './free-quotes.js';
import { createFreeSeller } from './free-session.js';
import { pump, withdrawAndRestart } from './phases.js';
import type { AcceptanceSession } from './session.js';

export interface FreeAcceptanceOptions {
  signal?: AbortSignal;
  onCase?: (value: FreeAcceptanceCase) => void;
}
export async function runFreeAcceptance(options: FreeAcceptanceOptions = {}) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(FREE_ACCEPTANCE.maxRunMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  assertAcceptanceActive(signal);
  const start = performance.now();
  let run: AcceptanceSession | undefined;
  let buyer: FreeAcceptanceBuyer | undefined;
  const cases: FreeAcceptanceCase[] = [];
  let answers = 0;
  const record = (value: FreeAcceptanceCase) => {
    assertAcceptanceActive(signal);
    cases.push(value);
    options.onCase?.(value);
    assertAcceptanceActive(signal);
  };
  try {
    run = await createFreeSeller(signal);
    const began = run.clock.now();
    acceptanceAssert(await run.host().publisher.tick());
    buyer = await createFreeBuyer(run);
    await buyer.answer();
    await pump(run, 1);
    answers++;
    record(FREE_ACCEPTANCE_CASES.DISCOVERY_ANSWER);
    const uninterrupted = run.host().wire;
    for (let cycle = 0; cycle < ACCEPTANCE.renewalCycles; cycle++) {
      const deadline = run.host().observation.readiness().validUntil;
      const sequence = run.host().control.records.current().record.sequence;
      await pump(run, OFFER_LIFETIME_MS - SELLER_READINESS.renewBeforeMs);
      acceptanceAssert(run.host().wire === uninterrupted);
      acceptanceAssert(
        run.host().observation.readiness().validUntil > deadline,
      );
      acceptanceAssert(
        run.host().control.records.current().record.sequence > sequence,
      );
      await buyer.answer();
      await pump(run, 1);
      answers++;
    }
    record(FREE_ACCEPTANCE_CASES.RENEWAL_ANSWERS);
    await freeAvailability(run, record);
    await buyer.answer();
    await pump(run, 1);
    answers++;
    const oldQuote = await acquireFreeQuote(run);
    try {
      await acceptQuote(run);
      await withdrawAndRestart(run);
      await run.clock.advance(1);
      acceptanceAssert(
        oldQuote.request.quote.offer.expiresAt > run.clock.now(),
      );
      await expectFreeRefusal(run, FREE_EXECUTION_CODES.EXPIRED, () =>
        rawFreeQuote(run!, oldQuote.endpoint, oldQuote.request),
      );
    } finally {
      await oldQuote.close();
    }
    buyer.refresh();
    await buyer.answer();
    await pump(run, 1);
    answers++;
    record(FREE_ACCEPTANCE_CASES.RESTART_REPLAY);
    await executionReplay(run);
    record(FREE_ACCEPTANCE_CASES.EXECUTION_REPLAY);
    await expiredQuote(run);
    record(FREE_ACCEPTANCE_CASES.EXPIRED_QUOTE);
    await wrongPeer(run);
    record(FREE_ACCEPTANCE_CASES.WRONG_PEER);
    await engineDown(run);
    record(FREE_ACCEPTANCE_CASES.ENGINE_DOWN);
    await capsExhausted(signal);
    record(FREE_ACCEPTANCE_CASES.FREE_CAPS);
    answers += await failoverCases(run);
    record(FREE_ACCEPTANCE_CASES.PRE_SEND_FAILOVER);
    record(FREE_ACCEPTANCE_CASES.NO_POST_SEND_FAILOVER);
    acceptanceAssert(
      buyer.queryGenerations() === 0 && buyer.queryEngineAttempts() === 0,
    );
    record(FREE_ACCEPTANCE_CASES.NO_QUERY_INFERENCE);
    let refused = false;
    await controlDeadline(
      async () => {
        try {
          const connection = await buyer!.endpoint.connect(
            run!.host().wire.endpoint.addr(),
            [...Buffer.from(GYBLOS_ALPN)],
          );
          connection.close(HTTP_OVER_IROH.streamCloseCode, []);
        } catch {
          refused = true;
        }
      },
      ACCEPTANCE.queryMs,
      () => {},
      signal,
    );
    acceptanceAssert(refused);
    record(FREE_ACCEPTANCE_CASES.NO_PAID_SERVICES);
    return {
      ok: true,
      schemaVersion: ACCEPTANCE.schemaVersion,
      mode: ACCEPTANCE_MODES.SYNTHETIC,
      clock: ACCEPTANCE_CLOCKS.ACCELERATED,
      index: ACCEPTANCE_INDEX,
      nativeIroh: true,
      paymentsEnabled: false,
      answers,
      queryGenerations: buyer.queryGenerations(),
      queryEngineAttempts: buyer.queryEngineAttempts(),
      elapsedMs: Math.round(performance.now() - start),
      simulatedMs: run.clock.now() - began,
      cases,
    };
  } catch (error) {
    assertAcceptanceActive(signal);
    throw error;
  } finally {
    try {
      await buyer?.close();
    } finally {
      await run?.close();
    }
  }
}
