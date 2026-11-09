// Captures snapshots synchronously; descriptive I/O never gates payment delivery or resource closure.
import type { ActivityHistory } from './activity-history';
import {
  unavailableActivity,
  type ActivityResult,
  type SessionActivity,
} from './activity-model';
import { DESKTOP_ACTIVITY } from './constants';
import {
  unavailablePaymentReferences,
  type PaymentReferenceResult,
  type PaypalPaymentReference,
} from './payment-reference-model';

export class ActivityObserver {
  private lastSnapshot = '';
  constructor(
    private readonly history: ActivityHistory,
    private readonly current: () => SessionActivity | null,
    private readonly readOnly: () => Promise<ActivityResult>,
    private readonly dispose: () => Promise<void> = async () => {},
    private readonly timeoutMs: number = DESKTOP_ACTIVITY.IO_TIMEOUT_MS,
    private readonly currentReference?: () => PaypalPaymentReference | null,
    private readonly readOnlyReferences: () => Promise<PaymentReferenceResult> = async () =>
      unavailablePaymentReferences(),
  ) {}
  capture = () => {
    const snapshot = this.current();
    if (!snapshot) return;
    const reference = this.currentReference?.();
    const key = JSON.stringify({ snapshot, reference });
    if (key === this.lastSnapshot) return;
    this.lastSnapshot = key;
    void this.history.observe(snapshot, reference);
  };
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.capture();
    try {
      return await work();
    } finally {
      this.capture();
    }
  }
  async summary() {
    this.capture();
    const current = this.current();
    return this.limit(
      current ? this.history.summary(current.id) : this.readOnly(),
      unavailableActivity(),
    );
  }
  async references() {
    this.capture();
    return this.limit(
      this.current() ? this.history.references() : this.readOnlyReferences(),
      unavailablePaymentReferences(),
    );
  }
  async close(closeRuntime: () => Promise<void>) {
    this.capture();
    try {
      await closeRuntime();
    } finally {
      this.capture();
      // The metadata lock survives any late write. Financial resources are already closed.
      const flushing = (
        this.lastSnapshot ? this.history.summary(null) : Promise.resolve()
      )
        .then(
          () => this.dispose(),
          () => this.dispose(),
        )
        .catch(() => {});
      await this.limit(flushing, undefined);
    }
  }
  private async limit<T>(work: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), this.timeoutMs);
    });
    try {
      return await Promise.race([work.catch(() => fallback), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
