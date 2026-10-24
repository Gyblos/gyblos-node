// Runs bounded, local-only node/discovery acceptance and returns sanitized evidence.
// Only an explicit engine mode can use local Ollama; no production index, paid path or on-chain operation.
import { acceptQuote } from './buyer.js';
import {
  ACCEPTANCE,
  ACCEPTANCE_CASES,
  ACCEPTANCE_CLOCKS,
  ACCEPTANCE_CODES,
  ACCEPTANCE_INDEX,
  ACCEPTANCE_MODES,
  type AcceptanceCase,
  type AcceptanceMode,
} from './constants.js';
import {
  acceptanceAssert,
  AcceptanceError,
  assertAcceptanceActive,
} from './errors.js';
import {
  busyRecovery,
  expiryRecovery,
  failureRecovery,
  renewalCycles,
  withdrawAndRestart,
} from './phases.js';
import { createAcceptanceSession, type AcceptanceSession } from './session.js';

export interface AcceptanceOptions {
  mode?: AcceptanceMode;
  signal?: AbortSignal;
  onCase?: (value: AcceptanceCase) => void;
}
export interface AcceptanceReport {
  schemaVersion: typeof ACCEPTANCE.schemaVersion;
  ok: true;
  mode: AcceptanceMode;
  clock: (typeof ACCEPTANCE_CLOCKS)[keyof typeof ACCEPTANCE_CLOCKS];
  index: typeof ACCEPTANCE_INDEX;
  nativeIroh: true;
  paymentsEnabled: false;
  renewals: number;
  elapsedMs: number;
  simulatedMs: number | null;
  cases: AcceptanceCase[];
}
export async function runNodeDiscoveryAcceptance(
  options: AcceptanceOptions = {},
): Promise<AcceptanceReport> {
  const mode = options.mode ?? ACCEPTANCE_MODES.SYNTHETIC;
  if (mode !== ACCEPTANCE_MODES.SYNTHETIC && mode !== ACCEPTANCE_MODES.OLLAMA)
    throw new AcceptanceError(ACCEPTANCE_CODES.INVALID_OPTIONS);
  const signal = AbortSignal.any([
    AbortSignal.timeout(ACCEPTANCE.maxRunMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  assertAcceptanceActive(signal);
  const started = performance.now();
  let run: AcceptanceSession | undefined;
  const cases: AcceptanceCase[] = [];
  const record = (value: AcceptanceCase) => {
    assertAcceptanceActive(signal);
    cases.push(value);
    options.onCase?.(value);
    assertAcceptanceActive(signal);
  };
  try {
    run = await createAcceptanceSession(mode, signal);
    const clockStart = run.clock.now();
    acceptanceAssert(await run.host().publisher.tick());
    await acceptQuote(run);
    record(ACCEPTANCE_CASES.DISCOVERY_QUOTE);
    await renewalCycles(run);
    record(ACCEPTANCE_CASES.RENEWAL_CYCLES);
    await busyRecovery(run);
    record(ACCEPTANCE_CASES.BUSY_RECOVERY);
    await failureRecovery(run);
    record(ACCEPTANCE_CASES.CHECK_FAILURE_RECOVERY);
    await expiryRecovery(run);
    record(ACCEPTANCE_CASES.EXPIRY_RECOVERY);
    await withdrawAndRestart(run);
    record(ACCEPTANCE_CASES.WITHDRAWAL_REPLAY);
    record(ACCEPTANCE_CASES.RESTART_SEQUENCE);
    record(ACCEPTANCE_CASES.NO_QUERY_INFERENCE);
    return {
      schemaVersion: ACCEPTANCE.schemaVersion,
      ok: true,
      mode,
      clock:
        mode === ACCEPTANCE_MODES.OLLAMA
          ? ACCEPTANCE_CLOCKS.WALL
          : ACCEPTANCE_CLOCKS.ACCELERATED,
      index: ACCEPTANCE_INDEX,
      nativeIroh: true,
      paymentsEnabled: false,
      renewals: ACCEPTANCE.renewalCycles,
      elapsedMs: Math.round(performance.now() - started),
      simulatedMs:
        mode === ACCEPTANCE_MODES.SYNTHETIC
          ? run.clock.now() - clockStart
          : null,
      cases,
    };
  } catch (error) {
    assertAcceptanceActive(signal);
    throw error;
  } finally {
    await run?.close();
  }
}
