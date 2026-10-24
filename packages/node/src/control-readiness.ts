// Owns cached seller readiness, actual inference activity and bounded background renewal.
// Control queries only read snapshots; checks never authorize payments or renew the legacy offer.
import { SELLER_READINESS } from '@gyblos/config';
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import { controlInteger } from '@gyblos/protocol/control-validation';
import type { Engine, EngineDescription } from '@gyblos/protocol/engine';

export interface SellerReadinessRenewal {
  model: EngineDescription;
  // Must settle only when its underlying work settles, even after cancellation.
  check: (
    signal: AbortSignal,
  ) => Promise<{ model: EngineDescription; offerExpiresAt: number }>;
  tickMs?: number;
  renewBeforeMs?: number;
  timeoutMs?: number;
}
class SellerReadiness {
  readonly engine: Engine;
  private active = 0;
  private generation = 1;
  private observedAt: number;
  private validUntil: number;
  private stopped = false;
  private running = false;
  private checking: AbortController | undefined;
  private loop: ReturnType<typeof setTimeout> | undefined;
  constructor(
    engine: Engine,
    validUntil: number,
    private readonly now: () => number,
    private readonly renewal?: SellerReadinessRenewal,
  ) {
    if (renewal) {
      for (const milliseconds of [
        renewal.tickMs,
        renewal.renewBeforeMs,
        renewal.timeoutMs,
      ])
        if (milliseconds !== undefined) controlInteger(milliseconds, 1);
    }
    this.observedAt = now();
    this.validUntil = validUntil;
    this.engine = {
      describe: () => engine.describe(),
      capabilities: () => engine.capabilities(),
      generate: async (input) => {
        this.active++;
        this.generation++;
        this.checking?.abort();
        try {
          return await engine.generate(input);
        } catch (error) {
          this.validUntil = 0;
          throw error;
        } finally {
          this.active--;
          this.generation++;
        }
      },
    };
  }
  readonly readiness = (): QuoteReadiness => ({
    generation: this.generation,
    busy: this.active > 0 || !!this.checking,
    observedAt: this.observedAt,
    validUntil: this.stopped ? 0 : this.validUntil,
  });
  async tick(): Promise<boolean> {
    const renewal = this.renewal;
    const now = this.now();
    if (
      !renewal ||
      this.stopped ||
      this.checking ||
      this.active > 0 ||
      (now >= this.observedAt &&
        this.validUntil - now >
          (renewal.renewBeforeMs ?? SELLER_READINESS.renewBeforeMs))
    )
      return false;
    this.validUntil = 0;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.checking = controller;
    const cancelled = new Promise<false>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(false), {
        once: true,
      });
    });
    const timer = setTimeout(
      () => controller.abort(),
      renewal.timeoutMs ?? SELLER_READINESS.timeoutMs,
    );
    const clearDeadline = () => clearTimeout(timer);
    controller.signal.addEventListener('abort', clearDeadline, { once: true });
    const operation = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return renewal.check(controller.signal);
      })
      .then(
        (result) => this.accept(result, generation, now, controller),
        () => false,
      )
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', clearDeadline);
        if (this.checking === controller) this.checking = undefined;
      });
    // Keep checking occupied until actual settlement; an ignored abort cannot spawn another check.
    return Promise.race([operation, cancelled]);
  }
  private accept(
    result: { model: EngineDescription; offerExpiresAt: number },
    generation: number,
    startedAt: number,
    controller: AbortController,
  ) {
    const now = this.now();
    const expected = this.renewal!.model;
    if (
      this.stopped ||
      controller.signal.aborted ||
      this.generation !== generation ||
      now < startedAt ||
      this.active > 0 ||
      !Number.isSafeInteger(result.offerExpiresAt) ||
      result.offerExpiresAt <= now ||
      result.model.name !== expected.name ||
      result.model.digest !== expected.digest ||
      result.model.contextTokens !== expected.contextTokens
    )
      return false;
    this.observedAt = now;
    this.validUntil = result.offerExpiresAt;
    this.generation++;
    return true;
  }
  start(onAvailable?: () => Promise<unknown>) {
    if (!this.renewal || this.stopped || this.running) return;
    this.running = true;
    const schedule = () => {
      this.loop = setTimeout(() => {
        this.loop = undefined;
        void this.tick()
          .then(async () => {
            const state = this.readiness();
            const now = this.now();
            if (
              !this.stopped &&
              !state.busy &&
              state.observedAt <= now &&
              state.validUntil > now
            )
              await onAvailable?.();
          })
          .catch(() => {
            this.validUntil = 0;
            this.generation++;
          })
          .finally(() => {
            if (!this.stopped) schedule();
          });
      }, this.renewal!.tickMs ?? SELLER_READINESS.tickMs);
    };
    schedule();
  }
  async stop() {
    this.stopped = true;
    this.validUntil = 0;
    this.generation++;
    clearTimeout(this.loop);
    this.loop = undefined;
    this.checking?.abort();
  }
}
export function observeControlReadiness(
  engine: Engine,
  validUntil: number,
  now: () => number = Date.now,
  renewal?: SellerReadinessRenewal,
) {
  return new SellerReadiness(engine, validUntil, now, renewal);
}
