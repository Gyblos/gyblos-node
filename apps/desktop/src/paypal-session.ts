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
> & { approvalLinkAvailable: boolean };

function visibleStatus(
  session: PaypalSession,
  approvalUrl?: string,
): DesktopPaypalStatus {
  const {
    phase,
    spentCents,
    limitCents,
    messageCents,
    remainingAttempts,
    expired,
  } = session.status();
  return {
    approvalLinkAvailable:
      phase === PAYPAL_SESSION_PHASE.CREATED && !!approvalUrl,
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

function serialOperations() {
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
  return {
    run,
    isBusy: () => busy,
    async close() {
      closing = true;
      await pending;
    },
  };
}

type DesktopPaypalSessionOptions = {
  checkEngine?: () => Promise<unknown>;
  checkAgentEngine?: () => Promise<unknown>;
};

async function prepareModels(options: DesktopPaypalSessionOptions) {
  let chatReady = !options.checkEngine;
  let agentReady = !options.checkEngine && !options.checkAgentEngine;
  if (options.checkEngine) {
    try {
      await options.checkEngine();
      chatReady = true;
    } catch {
      chatReady = false;
    }
  }
  if (options.checkAgentEngine) {
    try {
      await options.checkAgentEngine();
      agentReady = true;
    } catch {
      agentReady = false;
    }
  }
  if (!chatReady && !agentReady)
    throw new Error('No sandbox model is available.');
  return agentReady;
}

async function openApproval(
  session: PaypalSession,
  approvalUrl: string | undefined,
  openExternal: (url: string) => Promise<void>,
) {
  if (session.status().phase !== PAYPAL_SESSION_PHASE.CREATED || !approvalUrl)
    throw new Error('Sandbox approval link is unavailable.');
  await openExternal(sandboxApproval(approvalUrl));
}

function sendChat(session: PaypalSession, id: string, prompt: string) {
  return session.message(
    id,
    prompt,
    PAYPAL_REQUEST_LIMITS.maxTokens,
    randomUUID(),
  );
}

function sendAgent(
  session: PaypalSession,
  id: string,
  input: unknown,
  signal?: AbortSignal,
) {
  return session.agentMessage(id, input, randomUUID(), signal);
}

export function createDesktopPaypalSession(
  session: PaypalSession,
  openExternal: (url: string) => Promise<void>,
  options: DesktopPaypalSessionOptions = {},
) {
  let approvalUrl: string | undefined;
  let awaitingAcknowledgement = false;
  let checkoutOpened = false;
  let agentPreparedForSession = false;
  const { run, close, isBusy } = serialOperations();
  function orderId() {
    const id = session.status().orderId;
    if (!id) throw new Error('No sandbox order.');
    return id;
  }
  const status = () => visibleStatus(session, approvalUrl);
  async function checkAgent() {
    if (!agentPreparedForSession)
      throw new Error('A fresh agent session is required.');
    await options.checkAgentEngine?.();
  }
  return {
    status,
    isCloseBlocked: () => isBusy() || awaitingAcknowledgement || checkoutOpened,
    create: () =>
      run(async () => {
        const agentReady = await prepareModels(options);
        const order = await session.create();
        agentPreparedForSession = agentReady;
        approvalUrl = order.approvalUrl;
        return status();
      }),
    openApproval: () =>
      run(async () => {
        await openApproval(session, approvalUrl, openExternal);
        checkoutOpened = true;
      }),
    approve: () =>
      run(async () => {
        await session.approve(orderId());
        approvalUrl = undefined;
        return status();
      }),
    send: (prompt: string) =>
      run(async () => {
        await options.checkEngine?.();
        const answer = await sendChat(session, orderId(), prompt);
        awaitingAcknowledgement = true;
        return { text: answer.text, messageId: answer.messageId };
      }),
    sendAgent: (input: unknown, signal?: AbortSignal) =>
      run(async () => {
        await checkAgent();
        const answer = await sendAgent(session, orderId(), input, signal);
        awaitingAcknowledgement = true;
        return answer;
      }),
    prepareAgent: () => run(checkAgent),
    acknowledge: (messageId: string) =>
      run(async () => {
        await session.acknowledge(orderId(), messageId);
        awaitingAcknowledgement = false;
        return status();
      }),
    finish: () =>
      run(async () => {
        await session.finish(orderId());
        return status();
      }),
    abandon: () =>
      run(async () => {
        await session.cancel(orderId());
        approvalUrl = undefined;
        return status();
      }),
    close,
  };
}
