// Correlates a single browser return to the in-memory checkout that opened it.
import { timingSafeEqual } from 'node:crypto';

import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';
import type { createPaypalSession } from '@gyblos/node/paypal-session';
import { isPaypalReturnState } from '@gyblos/protocol/paypal-payment';

type PaypalSession = Awaited<ReturnType<typeof createPaypalSession>>;
export type PaypalReturn = { state: string; token?: string };

export class DesktopPaypalReturns {
  private state: string | undefined;
  private orderId: string | undefined;
  private opened = false;
  private delivered = false;
  private pending: string | undefined;
  private cancelled: string | undefined;
  constructor(
    private readonly session: PaypalSession,
    private readonly isClosing: () => boolean,
    private readonly isChecking: () => boolean,
  ) {}
  private matches(value: PaypalReturn) {
    const phase = this.session.status().phase;
    if (
      !this.state ||
      !this.orderId ||
      !isPaypalReturnState(value.state) ||
      (phase !== PAYPAL_SESSION_PHASE.CREATED &&
        !(
          this.isChecking() &&
          (phase === PAYPAL_SESSION_PHASE.REVIEW ||
            phase === PAYPAL_SESSION_PHASE.AUTHORIZING)
        )) ||
      this.session.status().orderId !== this.orderId ||
      (value.token !== undefined && value.token !== this.orderId)
    )
      return false;
    const received = Buffer.from(value.state);
    const expected = Buffer.from(this.state);
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  }
  start(state: string, orderId: string) {
    this.state = state;
    this.orderId = orderId;
    this.opened = false;
    this.delivered = false;
    this.pending = undefined;
    this.cancelled = undefined;
  }
  open() {
    if (!this.delivered) this.opened = true;
  }
  disarm() {
    this.opened = false;
    this.delivered = true;
    this.pending = undefined;
    this.cancelled = undefined;
  }
  approve(value: PaypalReturn) {
    if (
      this.isClosing() ||
      !this.opened ||
      this.delivered ||
      !this.matches(value)
    )
      return false;
    this.delivered = true;
    this.pending = this.orderId;
    return true;
  }
  cancel(value: PaypalReturn) {
    if (
      this.isClosing() ||
      !this.opened ||
      (this.delivered && !this.pending && !this.isChecking()) ||
      !this.matches(value)
    )
      return false;
    this.opened = false;
    this.delivered = true;
    this.pending = undefined;
    this.cancelled = this.orderId;
    return true;
  }
  hasCancellation() {
    return !!this.cancelled;
  }
  take() {
    const current = this.pending;
    this.pending = undefined;
    if (
      !current ||
      !this.opened ||
      current !== this.orderId ||
      this.session.status().phase !== PAYPAL_SESSION_PHASE.CREATED ||
      this.session.status().orderId !== current
    )
      return undefined;
    return current;
  }
  takeCancellation() {
    const current = this.cancelled;
    this.cancelled = undefined;
    return (
      !!current &&
      current === this.orderId &&
      this.session.status().phase === PAYPAL_SESSION_PHASE.CREATED &&
      this.session.status().orderId === current
    );
  }
}
