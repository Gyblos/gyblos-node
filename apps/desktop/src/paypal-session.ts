// Keeps sandbox order details in the host and serializes desktop session operations.
import { randomBytes, randomUUID } from 'node:crypto';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import {
  PAYPAL_REQUEST_LIMITS,
  PAYPAL_SESSION_PHASE,
} from '@gyblos/node/constants';
import type { createPaypalSession } from '@gyblos/node/paypal-session';
import {
  PAYPAL_ERROR_CODES,
  PAYPAL_RETURN_STATE_BYTES,
} from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import {
  PAYPAL_AGENT_ERROR,
  PaypalAgentConnectionError,
} from './paypal-agent-model';
import { desktopPaypalFinishActions } from './paypal-finish';
import { DesktopPaypalReturns, type PaypalReturn } from './paypal-return';
import { desktopPaypalReviewActions } from './paypal-review';

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
    isClosing: () => closing,
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

type CheckoutState = {
  approvalUrl: string | undefined;
  opened: boolean;
  checking: boolean;
};
export type CheckoutContext = {
  session: PaypalSession;
  openExternal: (url: string) => Promise<void>;
  options: DesktopPaypalSessionOptions;
  agent: AgentReadiness;
  state: CheckoutState;
  returns: DesktopPaypalReturns;
  run: ReturnType<typeof serialOperations>['run'];
  isClosing: () => boolean;
  orderId: () => string;
  status: () => DesktopPaypalStatus;
};

async function checkApproval(context: CheckoutContext, orderId: string) {
  context.state.checking = true;
  try {
    await context.session.approve(
      orderId,
      () => !context.isClosing() && !context.returns.hasCancellation(),
      () => {
        context.state.checking = false;
      },
    );
  } finally {
    context.state.checking = false;
  }
}

function checkoutEntryActions(context: CheckoutContext) {
  return {
    create: () =>
      context.run(async () => {
        const agentReady = await prepareModels(context.options);
        const state = randomBytes(PAYPAL_RETURN_STATE_BYTES).toString(
          'base64url',
        );
        const order = await context.session.create(state);
        context.returns.start(state, order.orderId);
        context.agent.prepared = agentReady;
        context.agent.unavailable = !agentReady;
        context.agent.scope = agentReady ? randomUUID() : undefined;
        context.state.approvalUrl = order.approvalUrl;
        return context.status();
      }),
    openApproval: () =>
      context.run(async () => {
        if (
          context.session.status().phase !== PAYPAL_SESSION_PHASE.CREATED ||
          !context.state.approvalUrl
        )
          throw new Error('Sandbox approval link is unavailable.');
        context.state.opened = true;
        context.returns.open();
        await context.openExternal(sandboxApproval(context.state.approvalUrl));
      }),
    approve: () =>
      context.run(async () => {
        try {
          await checkApproval(context, context.orderId());
        } catch (error) {
          if (
            !context.returns.hasCancellation() &&
            !(
              error instanceof PaypalError &&
              error.code === PAYPAL_ERROR_CODES.NOT_APPROVED
            )
          ) {
            context.returns.disarm();
            context.state.approvalUrl = undefined;
          }
          throw error;
        }
        context.returns.disarm();
        context.state.approvalUrl = undefined;
        return context.status();
      }),
  };
}

function checkoutReturnActions(context: CheckoutContext) {
  return {
    noteApprovedReturn(value: PaypalReturn) {
      return context.returns.approve(value);
    },
    noteCancelledReturn(value: PaypalReturn) {
      if (!context.returns.cancel(value)) return false;
      context.state.approvalUrl = undefined;
      return true;
    },
    consumeApprovedReturn: () =>
      context.run(async () => {
        const pending = context.returns.take();
        if (!pending) return context.status();
        try {
          await checkApproval(context, pending);
        } finally {
          if (!context.returns.hasCancellation()) context.returns.disarm();
          context.state.approvalUrl = undefined;
        }
        return context.status();
      }),
    consumeCancelledReturn: () =>
      context.run(async () => context.returns.takeCancellation()),
  };
}

export function createDesktopPaypalSession(
  session: PaypalSession,
  openExternal: (url: string) => Promise<void>,
  options: DesktopPaypalSessionOptions = {},
) {
  let awaitingAcknowledgement = false;
  const agent: AgentReadiness = {
    prepared: false,
    unavailable: false,
    scope: undefined,
  };
  const state: CheckoutState = {
    approvalUrl: undefined,
    opened: false,
    checking: false,
  };
  const { run, close, isBusy, isClosing } = serialOperations();
  const returns = new DesktopPaypalReturns(
    session,
    isClosing,
    () => state.checking,
  );
  const orderId = () => currentOrderId(session);
  const status = () => visibleStatus(session, state.approvalUrl);
  const checkAgent = agentCheck(
    options,
    () => agent.prepared,
    () => agent.unavailable,
  );
  const checkout: CheckoutContext = {
    session,
    openExternal,
    options,
    agent,
    state,
    returns,
    run,
    isClosing,
    orderId,
    status,
  };
  return {
    status,
    isBusy,
    isCloseBlocked: () => isBusy() || awaitingAcknowledgement || state.opened,
    ...checkoutEntryActions(checkout),
    ...checkoutReturnActions(checkout),
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
    ...desktopPaypalFinishActions(checkout, () => clearAgent(agent)),
    ...desktopPaypalReviewActions(checkout, () => clearAgent(agent)),
    abandon: () =>
      run(async () => {
        await session.cancel(orderId());
        clearAgent(agent);
        returns.disarm();
        state.approvalUrl = undefined;
        return status();
      }),
    close,
  };
}
