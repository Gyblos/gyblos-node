import { DIAGNOSTICS, P2P } from '@gyblos/config';
import type { Engine, EngineDescription } from '@gyblos/core/engine';
import { READINESS_GENERATION } from '@gyblos/engine-ollama/constants';
import {
  assertMemoryHeadroom,
  type MemorySnapshot,
} from '@gyblos/runtime/memory';

export interface ReadinessRecord {
  status: 'passed' | 'failed';
  reason:
    | 'ready'
    | 'memory-observation-failed'
    | 'insufficient-headroom'
    | 'warmup-failed'
    | 'warmup-timeout';
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

export async function prepareSellerEngine(
  engine: Engine,
  dependencies: {
    snapshot: () => Promise<MemorySnapshot>;
    record: (record: ReadinessRecord) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<{ model: EngineDescription; offerExpiresAt: number }> {
  let before: MemorySnapshot | null = null;
  let reason: ReadinessRecord['reason'] = 'memory-observation-failed';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController(),
    start = performance.now();
  try {
    before = await dependencies.snapshot();
    reason = 'insufficient-headroom';
    assertMemoryHeadroom(before);
    reason = 'warmup-failed';
    if (P2P.offerLifetimeMs >= READINESS_GENERATION.residencyMs)
      throw new Error('Offer lifetime exceeds warmed model residency.');
    const model = await engine.describe();
    await Promise.race([
      engine.generate({
        prompt: READINESS_GENERATION.prompt,
        maxTokens: READINESS_GENERATION.maxTokens,
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reason = 'warmup-timeout';
          controller.abort();
          reject(new Error('Private warmup timed out.'));
        }, dependencies.timeoutMs ?? DIAGNOSTICS.warmupMs);
      }),
    ]);
    clearTimeout(timer);
    const offerExpiresAt = Date.now() + P2P.offerLifetimeMs;
    reason = 'memory-observation-failed';
    const after = await dependencies.snapshot();
    reason = 'warmup-failed';
    if (
      before.cgroup &&
      after.cgroup &&
      after.cgroup.events.oomKill > before.cgroup.events.oomKill
    )
      throw new Error('OOM observed during private warmup.');
    reason = 'insufficient-headroom';
    assertMemoryHeadroom(after);
    reason = 'warmup-failed';
    assertReadinessCurrent(offerExpiresAt);
    await dependencies.record({
      status: 'passed',
      reason: 'ready',
      before,
      after,
      warmupMs: performance.now() - start,
    });
    return { model, offerExpiresAt };
  } catch {
    controller.abort();
    const after = await dependencies.snapshot().catch(() => null);
    await dependencies.record({
      status: 'failed',
      reason,
      before,
      after,
      warmupMs: performance.now() - start,
    });
    throw new Error(
      reason === 'insufficient-headroom'
        ? 'Insufficient memory headroom; seller not advertised.'
        : 'Private engine warmup failed; seller not advertised.',
    );
  } finally {
    clearTimeout(timer);
  }
}
