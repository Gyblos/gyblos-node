// In-process ownership for bounded seller concurrency; durable journals remain the financial authority.
import { TRANSPORT_LIMITS } from '@gyblos/config';
import {
  PaymentSessionError,
  SESSION_CODES,
  sessionFail,
} from '@gyblos/protocol/payment-session';

export interface PoolLease {
  requestId: string;
  registered: boolean;
  running: boolean;
  sent: boolean;
  controller: AbortController;
}
function createLease(requestId: string): PoolLease {
  return {
    requestId,
    registered: false,
    running: true,
    sent: false,
    controller: new AbortController(),
  };
}
function trackOperation<T>(
  pending: Set<Promise<unknown>>,
  operation: Promise<T>,
) {
  pending.add(operation);
  void operation.then(
    () => pending.delete(operation),
    () => pending.delete(operation),
  );
  return operation;
}
function forbid(): never {
  return sessionFail(SESSION_CODES.BUSY);
}
export function createPoolAdmissions() {
  const leases = new Map<string, PoolLease>();
  const pending = new Set<Promise<unknown>>();
  let queue = Promise.resolve();
  let blocked = false;
  let revision = 0;
  let maintenance = false;
  let closing = false;
  const uncertain = () => {
    revision++;
    blocked = true;
    for (const lease of leases.values())
      if (!lease.sent)
        lease.controller.abort(
          new PaymentSessionError(SESSION_CODES.UNVERIFIED),
        );
  };
  const track = <T>(operation: Promise<T>) =>
    trackOperation(pending, operation);
  return {
    leases,
    enter(id: string, requestId: string) {
      if (
        closing ||
        maintenance ||
        leases.has(id) ||
        leases.size >= TRANSPORT_LIMITS.maxConcurrent
      )
        return forbid();
      const lease = createLease(requestId);
      leases.set(id, lease);
      return lease;
    },
    leave(id: string, lease: PoolLease) {
      if (leases.get(id) === lease) leases.delete(id);
    },
    beforeExecute(id: string) {
      const lease = leases.get(id);
      if (!lease || !lease.registered || !lease.running || blocked || closing)
        return sessionFail(SESSION_CODES.UNVERIFIED);
      lease.controller.signal.throwIfAborted();
      lease.sent = true;
    },
    uncertain,
    check() {
      if (blocked || closing) return sessionFail(SESSION_CODES.UNVERIFIED);
    },
    revision: () => revision,
    block(value: boolean, observed = revision) {
      if (value) uncertain();
      else if (observed === revision) blocked = false;
      return blocked;
    },
    serial<T>(run: () => Promise<T>): Promise<T> {
      const task = queue.then(run);
      queue = task.then(
        () => {},
        () => {},
      );
      return task;
    },
    track,
    async maintain<T>(run: () => Promise<T>): Promise<T> {
      if (closing || maintenance || leases.size) return forbid();
      maintenance = true;
      try {
        return await track(Promise.resolve().then(run));
      } finally {
        maintenance = false;
      }
    },
    async drain() {
      closing = true;
      while (pending.size) await Promise.allSettled([...pending]);
      await queue;
    },
  };
}
