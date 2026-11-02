// Keeps sandbox order details in the host and serializes desktop session operations.
import { randomUUID } from 'node:crypto';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import {
  PAYPAL_REQUEST_LIMITS,
  PAYPAL_SESSION_PHASE,
} from '@gyblos/node/constants';
import type { createPaypalSession } from '@gyblos/node/paypal-session';

type PaypalSession = Awaited<ReturnType<typeof createPaypalSession>>;
export type DesktopPaypalStatus = Omit<
  ReturnType<PaypalSession['status']>,
  'orderId'
>;

function visibleStatus(session: PaypalSession): DesktopPaypalStatus {
  const {
    phase,
    spentCents,
    limitCents,
    messageCents,
    remainingAttempts,
    expired,
  } = session.status();
  return {
    phase,
    spentCents,
    limitCents,
    messageCents,
    remainingAttempts,
    expired,
  };
}

function sandboxApproval(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== PAYPAL_SANDBOX.approvalHost ||
    url.port ||
    url.username ||
    url.password
  )
    throw new Error('Invalid sandbox approval link.');
  return url.href;
}

export function createDesktopPaypalSession(
  session: PaypalSession,
  openExternal: (url: string) => Promise<void>,
) {
  let approvalUrl: string | undefined;
  let busy = false;
  let closing = false;
  let pending: Promise<void> = Promise.resolve();

  function run<T>(action: () => Promise<T>): Promise<T> {
    if (busy || closing) return Promise.reject(new Error('Session is busy.'));
    busy = true;
    const result = (async () => {
      try {
        return await action();
      } finally {
        busy = false;
      }
    })();
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function orderId() {
    const id = session.status().orderId;
    if (!id) throw new Error('No sandbox order.');
    return id;
  }
  return {
    status: () => visibleStatus(session),
    create: () =>
      run(async () => {
        const order = await session.create();
        approvalUrl = order.approvalUrl;
        return visibleStatus(session);
      }),
    openApproval: () =>
      run(async () => {
        if (
          session.status().phase !== PAYPAL_SESSION_PHASE.CREATED ||
          !approvalUrl
        )
          throw new Error('Sandbox approval link is unavailable.');
        await openExternal(sandboxApproval(approvalUrl));
      }),
    approve: () =>
      run(async () => {
        await session.approve(orderId());
        approvalUrl = undefined;
        return visibleStatus(session);
      }),
    send: (prompt: string) =>
      run(async () => {
        const answer = await session.message(
          orderId(),
          prompt,
          PAYPAL_REQUEST_LIMITS.maxTokens,
          randomUUID(),
        );
        return { text: answer.text, messageId: answer.messageId };
      }),
    acknowledge: (messageId: string) =>
      run(async () => {
        await session.acknowledge(orderId(), messageId);
        return visibleStatus(session);
      }),
    finish: () =>
      run(async () => {
        await session.finish(orderId());
        return visibleStatus(session);
      }),
    abandon: () =>
      run(async () => {
        await session.cancel(orderId());
        approvalUrl = undefined;
        return visibleStatus(session);
      }),
    async close() {
      closing = true;
      await pending;
    },
  };
}
