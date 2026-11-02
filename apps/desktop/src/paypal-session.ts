// Keeps sandbox order details in the host and serializes desktop session operations.
import { randomUUID } from 'node:crypto';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import {
  PAYPAL_REQUEST_LIMITS,
  PAYPAL_SESSION_PHASE,
} from '@gyblos/node/constants';
import type { createPaypalSession } from '@gyblos/node/paypal-session';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_AGENT_ERROR,
  PaypalAgentConnectionError,
} from './paypal-agent-model';

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
    if (closing)
      return Promise.reject(
        new PaypalError(PAYPAL_ERROR_CODES.NEEDS_RECONCILIATION),
      );
    if (busy) return Promise.reject(new PaypalError(PAYPAL_ERROR_CODES.BUSY));
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
  idempotencyKey?: string,
) {
  return session.agentMessage(id, input, randomUUID(), signal, idempotencyKey);
}

function agentCheck(
  options: DesktopPaypalSessionOptions,
  ready: () => boolean,
  unavailable: () => boolean,
) {
  return async () => {
    if (!ready())
      throw new PaypalAgentConnectionError(
        unavailable()
          ? PAYPAL_AGENT_ERROR.MODEL_UNAVAILABLE
          : PAYPAL_AGENT_ERROR.NEW_SESSION_REQUIRED,
      );
    try {
      await options.checkAgentEngine?.();
    } catch {
      throw new PaypalAgentConnectionError(
        PAYPAL_AGENT_ERROR.MODEL_UNAVAILABLE,
      );
    }
  };
}

function agentOperations(
  session: PaypalSession,
  run: ReturnType<typeof serialOperations>['run'],
  check: () => Promise<void>,
  orderId: () => string,
) {
  return {
    sendAgent: (
      input: unknown,
      signal?: AbortSignal,
      idempotencyKey?: string,
    ) =>
      run(async () => {
        await check();
        return sendAgent(session, orderId(), input, signal, idempotencyKey);
      }),
    prepareAgent: () => run(check),
  };
}

type AgentReadiness = {
  prepared: boolean;
  unavailable: boolean;
  scope: string | undefined;
};
function clearAgent(state: AgentReadiness) {
  state.prepared = false;
  state.unavailable = false;
  state.scope = undefined;
}

function currentOrderId(session: PaypalSession) {
  const id = session.status().orderId;
  if (!id) throw new Error('No sandbox order.');
  return id;
}

export function createDesktopPaypalSession(
  session: PaypalSession,
  openExternal: (url: string) => Promise<void>,
  options: DesktopPaypalSessionOptions = {},
) {
  let approvalUrl: string | undefined;
  let awaitingAcknowledgement = false;
  let checkoutOpened = false;
  const agent: AgentReadiness = {
    prepared: false,
    unavailable: false,
    scope: undefined,
  };
  const { run, close, isBusy } = serialOperations();
  const orderId = () => currentOrderId(session);
  const status = () => visibleStatus(session, approvalUrl);
  const checkAgent = agentCheck(
    options,
    () => agent.prepared,
    () => agent.unavailable,
  );
  return {
    status,
    isBusy,
    isCloseBlocked: () => isBusy() || awaitingAcknowledgement || checkoutOpened,
    create: () =>
      run(async () => {
        const agentReady = await prepareModels(options);
        const order = await session.create();
        agent.prepared = agentReady;
        agent.unavailable = !agentReady;
        agent.scope = agentReady ? randomUUID() : undefined;
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
    ...agentOperations(session, run, checkAgent, orderId),
    agentScope: () => agent.scope,
    acknowledge: (messageId: string) =>
      run(async () => {
        await session.acknowledge(orderId(), messageId);
        awaitingAcknowledgement = false;
        return status();
      }),
    finish: () =>
      run(async () => {
        await session.finish(orderId());
        clearAgent(agent);
        return status();
      }),
    abandon: () =>
      run(async () => {
        await session.cancel(orderId());
        clearAgent(agent);
        approvalUrl = undefined;
        return status();
      }),
    close,
  };
}
