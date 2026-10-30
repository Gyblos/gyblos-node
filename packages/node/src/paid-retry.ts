// Retries pending claims in the background with exactly the charge each terminal reported, first at
// once and then after each delay of a bounded schedule. A settlement or a lapse ends a claim; so does a
// refusal retrying cannot fix, or the end of the schedule, both counted as failed for the operator.
// The port settles a channel once, so repeating a charge that already landed returns that settlement.
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAdmission,
  type PaymentServer,
} from '@gyblos/protocol/payment';

export interface PaidRetryOptions {
  payment: PaymentServer;
  // Waits between attempts; the claim is given up after the last one fails.
  delaysMs: readonly number[];
}

export interface PaidRetryHealth {
  queued: number;
  settled: number;
  failed: number;
}

const RETRYABLE: readonly string[] = [
  PAYMENT_ERROR_CODES.UNAVAILABLE,
  PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE,
];

const OUTCOMES = {
  SETTLED: 'settled',
  LAPSED: 'lapsed',
  RETRY: 'retry',
  FAILED: 'failed',
} as const;
type Outcome = (typeof OUTCOMES)[keyof typeof OUTCOMES];

async function attempt(
  payment: PaymentServer,
  admission: PaymentAdmission,
  chargedAtomic: string,
): Promise<Outcome> {
  try {
    await payment.settle(admission, chargedAtomic);
    return OUTCOMES.SETTLED;
  } catch (error) {
    if (!(error instanceof PaymentError)) return OUTCOMES.FAILED;
    if (error.code === PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED)
      return OUTCOMES.LAPSED;
    return RETRYABLE.includes(error.code) ? OUTCOMES.RETRY : OUTCOMES.FAILED;
  }
}

export function createPaidRetry(options: PaidRetryOptions) {
  const claims = new Map<string, Promise<void>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wakers = new Set<() => void>();
  const counts = { settled: 0, failed: 0 };
  let stopped = false;
  const wait = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        timers.delete(timer);
        wakers.delete(wake);
        resolve(false);
      };
      const timer = setTimeout(() => {
        timers.delete(timer);
        wakers.delete(wake);
        resolve(true);
      }, ms);
      timers.add(timer);
      wakers.add(wake);
    });
  async function run(admission: PaymentAdmission, chargedAtomic: string) {
    for (let index = 0; !stopped; index++) {
      const outcome = await attempt(options.payment, admission, chargedAtomic);
      if (outcome === OUTCOMES.SETTLED) counts.settled++;
      if (outcome === OUTCOMES.FAILED) counts.failed++;
      if (outcome !== OUTCOMES.RETRY) return;
      // Stopping while an attempt ran must not start a new wait.
      if (stopped) return;
      const delay = options.delaysMs[index];
      if (delay === undefined) {
        counts.failed++;
        return;
      }
      if (!(await wait(delay))) return;
    }
  }
  return {
    // Ignored once stopping; a channel already queued keeps its first charge.
    queue(admission: PaymentAdmission, chargedAtomic: string) {
      if (stopped || claims.has(admission.channelId)) return;
      const running = run(admission, chargedAtomic).finally(() => {
        if (claims.get(admission.channelId) === running)
          claims.delete(admission.channelId);
      });
      claims.set(admission.channelId, running);
    },
    health(): PaidRetryHealth {
      return { queued: claims.size, ...counts };
    },
    // Cancels waiting retries. An attempt already running is not awaited, so a hung claim never
    // blocks shutdown; its outcome is ignored and the payment server refuses writes once closed.
    async stop() {
      stopped = true;
      for (const wake of [...wakers]) wake();
      claims.clear();
    },
  };
}
