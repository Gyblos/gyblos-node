// Holds the seller until the engine is ready: checks memory headroom, runs one bounded private warmup, records
// the outcome and anchors offer expiry to the warmed model's residency.
import { DIAGNOSTICS } from '@gyblos/config';
import { OFFER_LIFETIME_MS } from '@gyblos/core/constants';
import { type Engine, type EngineDescription } from '@gyblos/protocol/engine';
import {
  assertMemoryHeadroom,
  type MemorySnapshot,
} from '@gyblos/runtime/memory';

import { READINESS_REASONS, READINESS_STATUSES } from './constants';
import type { EngineReadinessPolicy } from './engine-factory';

export interface ReadinessRecord {
  status: (typeof READINESS_STATUSES)[keyof typeof READINESS_STATUSES];
  reason: (typeof READINESS_REASONS)[keyof typeof READINESS_REASONS];
  before: MemorySnapshot | null;
  after: MemorySnapshot | null;
  warmupMs: number;
}

export function assertReadinessCurrent(
  offerExpiresAt: number,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(offerExpiresAt) || now >= offerExpiresAt)
    throw new Error(
      'Private engine readiness expired before offer publication.',
    );
}

interface ProbeDependencies {
  // From the engine plugin: the warmup to run and how long the warmed model stays resident.
  policy: EngineReadinessPolicy;
  snapshot: () => Promise<MemorySnapshot>;
  now?: () => number;
}

// Caller owns the deadline. This promise retains the actual engine-work slot after an abort.
export async function probeSellerEngine(
  engine: Engine,
  signal: AbortSignal,
  dependencies: ProbeDependencies,
) {
  const check = new EngineReadinessCheck(engine, signal, dependencies);
  return check.run();
}

class EngineReadinessCheck {
  before: MemorySnapshot | null = null;
  after: MemorySnapshot | null = null;
  reason: ReadinessRecord['reason'] =
    READINESS_REASONS.MEMORY_OBSERVATION_FAILED;
  private readonly start = performance.now();
  constructor(
    private readonly engine: Engine,
    private readonly signal: AbortSignal,
    private readonly dependencies: ProbeDependencies,
  ) {}
  async run() {
    this.signal.throwIfAborted();
    this.before = await this.dependencies.snapshot();
    this.signal.throwIfAborted();
    this.reason = READINESS_REASONS.INSUFFICIENT_HEADROOM;
    assertMemoryHeadroom(this.before);
    this.reason = READINESS_REASONS.WARMUP_FAILED;
    const { warmup, residencyMs } = this.dependencies.policy;
    if (!(residencyMs > OFFER_LIFETIME_MS))
      throw new Error('Offer lifetime exceeds warmed model residency.');
    const model = await this.engine.describe();
    this.signal.throwIfAborted();
    await this.engine.generate({
      prompt: warmup.prompt,
      maxTokens: warmup.maxTokens,
      signal: this.signal,
    });
    this.signal.throwIfAborted();
    const now = this.dependencies.now ?? Date.now;
    const offerExpiresAt = now() + OFFER_LIFETIME_MS;
    this.reason = READINESS_REASONS.MEMORY_OBSERVATION_FAILED;
    this.after = await this.dependencies.snapshot();
    this.signal.throwIfAborted();
    this.reason = READINESS_REASONS.WARMUP_FAILED;
    if (
      this.before.cgroup &&
      this.after.cgroup &&
      this.after.cgroup.events.oomKill > this.before.cgroup.events.oomKill
    )
      throw new Error('OOM observed during private warmup.');
    this.reason = READINESS_REASONS.INSUFFICIENT_HEADROOM;
    assertMemoryHeadroom(this.after);
    this.reason = READINESS_REASONS.WARMUP_FAILED;
    assertReadinessCurrent(offerExpiresAt, now());
    return { model, offerExpiresAt };
  }
  record(passed: boolean): ReadinessRecord {
    return {
      status: passed ? READINESS_STATUSES.PASSED : READINESS_STATUSES.FAILED,
      reason: passed ? READINESS_REASONS.READY : this.reason,
      before: this.before,
      after: this.after,
      warmupMs: performance.now() - this.start,
    };
  }
}

export async function prepareSellerEngine(
  engine: Engine,
  dependencies: ProbeDependencies & {
    record: (record: ReadinessRecord) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<{ model: EngineDescription; offerExpiresAt: number }> {
  const controller = new AbortController();
  const check = new EngineReadinessCheck(
    engine,
    controller.signal,
    dependencies,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      check.run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          check.reason = READINESS_REASONS.WARMUP_TIMEOUT;
          controller.abort();
          reject(new Error('Private warmup timed out.'));
        }, dependencies.timeoutMs ?? DIAGNOSTICS.warmupMs);
      }),
    ]);
    clearTimeout(timer);
    await dependencies.record(check.record(true));
    return result;
  } catch {
    controller.abort();
    await dependencies.record(check.record(false));
    throw new Error(
      check.reason === READINESS_REASONS.INSUFFICIENT_HEADROOM
        ? 'Insufficient memory headroom; seller not advertised.'
        : 'Private engine warmup failed; seller not advertised.',
    );
  } finally {
    clearTimeout(timer);
  }
}
