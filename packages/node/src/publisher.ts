// Schedules bounded public announcements with injected transport; never infers, pays or reserves capacity.
// Shutdown disables local snapshots first, then attempts one higher withdrawal; expiry covers failed delivery.
import { SELLER_DISCOVERY } from '@gyblos/config';
import type { SignedPublicV2 } from '@gyblos/protocol/control-types';
import { controlInteger } from '@gyblos/protocol/control-validation';

import {
  NODE_ERROR_CODES,
  SELLER_PUBLICATION_STATES,
  type SellerPublicationState,
} from './constants.js';
import type { SellerPublicRecords } from './public-records.js';

export interface SellerPublisherOptions {
  records: SellerPublicRecords;
  publish: (record: SignedPublicV2, signal: AbortSignal) => Promise<void>;
  canPublish: () => boolean;
  now?: () => number;
  tickMs?: number;
  retryMs?: number;
}
function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}
class SellerPublisher {
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly retryMs: number;
  private operation: Promise<unknown> = Promise.resolve();
  private loop: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private stopped = false;
  private sent: SignedPublicV2 | undefined;
  private forceCatalog = false;
  private failures = 0;
  private retryAt = 0;
  private status: SellerPublicationState = SELLER_PUBLICATION_STATES.IDLE;
  private lastError: typeof NODE_ERROR_CODES.DISCOVERY_PUBLISH_FAILED | null =
    null;
  constructor(private readonly options: SellerPublisherOptions) {
    this.now = options.now ?? Date.now;
    this.tickMs = controlInteger(
      options.tickMs ?? SELLER_DISCOVERY.tickMs,
      1,
      SELLER_DISCOVERY.maxRetryMs,
    );
    this.retryMs = controlInteger(
      options.retryMs ?? SELLER_DISCOVERY.retryMs,
      1,
      SELLER_DISCOVERY.maxRetryMs,
    );
  }
  health() {
    return {
      status: this.status,
      failures: this.failures,
      lastError: this.lastError,
    };
  }
  private failure() {
    this.failures++;
    this.lastError = NODE_ERROR_CODES.DISCOVERY_PUBLISH_FAILED;
    this.status = SELLER_PUBLICATION_STATES.DEGRADED;
    // Saturate the exponent as well as the delay, even after very long outages.
    const exponent = Math.min(
      this.failures - 1,
      Math.ceil(Math.log2(SELLER_DISCOVERY.maxRetryMs / this.retryMs)),
    );
    this.retryAt =
      this.now() +
      Math.min(this.retryMs * 2 ** exponent, SELLER_DISCOVERY.maxRetryMs);
    this.forceCatalog = true;
  }
  private async step() {
    if (this.stopped) return false;
    if (this.now() < this.retryAt) return false;
    try {
      if (!this.options.canPublish()) {
        const withdrawal = await this.options.records.withdraw();
        this.sent = undefined;
        this.forceCatalog = true;
        if (withdrawal)
          await this.options.publish(withdrawal, this.controller.signal);
        this.status = SELLER_PUBLICATION_STATES.IDLE;
        return false;
      }
      const catalog = await this.options.records.refresh(this.forceCatalog);
      if (catalog !== this.sent) {
        await this.options.publish(catalog, this.controller.signal);
        if (this.stopped) return false;
        this.sent = catalog;
      }
      const presence = await this.options.records.presence();
      if (this.stopped) return false;
      await this.options.publish(presence, this.controller.signal);
      if (this.stopped) return false;
      this.forceCatalog = false;
      this.failures = 0;
      this.retryAt = 0;
      this.lastError = null;
      this.status = SELLER_PUBLICATION_STATES.RUNNING;
      return true;
    } catch {
      if (!this.stopped) this.failure();
      return false;
    }
  }
  tick(): Promise<boolean> {
    const result = this.operation.then(() => this.step());
    this.operation = result;
    return result;
  }
  start() {
    if (this.loop || this.stopped) return;
    this.loop = (async () => {
      while (!this.stopped) {
        await this.tick();
        await wait(this.tickMs, this.controller.signal);
      }
    })();
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    // Invalidate quotes before waiting for a slow/in-flight publication to cancel.
    const retiring = this.options.records.withdraw().catch(() => {
      this.failure();
      return undefined;
    });
    this.controller.abort();
    this.stopping = (async () => {
      await this.operation;
      await this.loop;
      const withdrawal = await retiring;
      if (withdrawal) {
        try {
          await this.options.publish(
            withdrawal,
            AbortSignal.timeout(SELLER_DISCOVERY.requestMs),
          );
        } catch {
          this.failure();
        }
      }
      this.status = SELLER_PUBLICATION_STATES.STOPPED;
    })();
    return this.stopping;
  }
}
export function createSellerPublisher(options: SellerPublisherOptions) {
  return new SellerPublisher(options);
}
