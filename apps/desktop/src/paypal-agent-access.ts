// Owns one local agent endpoint for the lifetime of the desktop sandbox session.
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';

import { PAYPAL_AGENT_USAGE_STATE as USAGE } from './constants';
import { validPaypalAgentSpendLimit } from './paypal-agent-limit';

type Endpoint = {
  url: string;
  key: string;
  model: string;
  isCurrent(): boolean;
  isBusy(): boolean;
  close(): Promise<void>;
  budget(): { keyLimitCents: number; keySpentCents: number };
};

type SessionStatus = {
  phase: unknown;
  expired: boolean;
  spentCents: number;
  limitCents: number;
  remainingAttempts: number;
};
function usageState(
  endpoint: Endpoint,
  state: SessionStatus,
  disconnecting: boolean,
  disconnectFailed: boolean,
  sessionBusy: boolean,
) {
  if (disconnectFailed) return USAGE.DISCONNECT_FAILED;
  if (disconnecting) return USAGE.DISCONNECTING;
  if (endpoint.isBusy() || sessionBusy) return USAGE.BUSY;
  if (state.phase === PAYPAL_SESSION_PHASE.MESSAGE_PENDING)
    return USAGE.CHAT_PENDING;
  if (state.phase !== PAYPAL_SESSION_PHASE.ACTIVE) return USAGE.NEEDS_REVIEW;
  if (state.expired) return USAGE.EXPIRED;
  if (state.remainingAttempts === 0) return USAGE.ATTEMPTS_EXHAUSTED;
  if (state.spentCents >= state.limitCents) return USAGE.LIMIT_REACHED;
  const budget = endpoint.budget();
  if (budget.keySpentCents >= budget.keyLimitCents)
    return USAGE.KEY_LIMIT_REACHED;
  return USAGE.AVAILABLE;
}
function snapshot(
  endpoint: Endpoint,
  state: SessionStatus,
  disconnecting: boolean,
  disconnectFailed: boolean,
  sessionBusy: boolean,
) {
  const usage = usageState(
    endpoint,
    state,
    disconnecting,
    disconnectFailed,
    sessionBusy,
  );
  const budget = endpoint.budget();
  return {
    url: endpoint.url,
    model: endpoint.model,
    keyLimitCents: budget.keyLimitCents,
    keySpentCents: budget.keySpentCents,
    spentCents: state.spentCents,
    limitCents: state.limitCents,
    disconnecting: usage === USAGE.DISCONNECTING,
    usageUncertain: usage !== USAGE.AVAILABLE,
    usageState: usage,
  };
}

type EndpointState = {
  current: Endpoint | undefined;
  opening: Promise<Endpoint> | undefined;
  disconnecting: boolean;
  disconnectFailed: boolean;
};
function ensureEndpoint(access: EndpointState, start: () => Promise<Endpoint>) {
  const stale =
    access.current && !access.current.isCurrent() ? access.current : undefined;
  if (stale) {
    if (stale.isBusy())
      return Promise.reject(new Error('An agent response is pending.'));
    access.current = undefined;
    access.opening = undefined;
  }
  if (!access.opening) {
    const next = Promise.resolve()
      .then(async () => {
        await stale?.close();
        return start();
      })
      .then(async (endpoint) => {
        if (!endpoint.isCurrent()) {
          await endpoint.close();
          throw new Error('Agent access expired.');
        }
        access.current = endpoint;
        return endpoint;
      })
      .catch((error: unknown) => {
        if (access.opening === next) access.opening = undefined;
        throw error;
      });
    access.opening = next;
  }
  return access.opening;
}
async function disconnectEndpoint(access: EndpointState) {
  const endpoint = access.opening ? await access.opening : undefined;
  access.disconnecting = !!endpoint;
  access.disconnectFailed = false;
  try {
    await endpoint?.close();
  } catch (error) {
    access.disconnecting = false;
    access.disconnectFailed = !!endpoint;
    throw error;
  }
  access.opening = undefined;
  access.current = undefined;
  access.disconnecting = false;
}
function currentSnapshot(
  access: EndpointState,
  status: () => SessionStatus,
  isSessionBusy: () => boolean,
) {
  return access.current &&
    (access.current.isCurrent() ||
      access.disconnecting ||
      access.disconnectFailed)
    ? snapshot(
        access.current,
        status(),
        access.disconnecting,
        access.disconnectFailed,
        isSessionBusy(),
      )
    : null;
}

function copyEndpointKey(
  access: EndpointState,
  closing: boolean,
  write: (secret: string) => void,
) {
  if (
    !access.current ||
    !access.current.isCurrent() ||
    closing ||
    access.disconnecting ||
    access.disconnectFailed
  )
    return false;
  write(access.current.key);
  return true;
}

export function createDesktopPaypalAgentAccess(
  status: () => SessionStatus,
  start: (limitCents: number) => Promise<Endpoint>,
  isSessionBusy: () => boolean = () => false,
) {
  const access: EndpointState = {
    opening: undefined,
    current: undefined,
    disconnecting: false,
    disconnectFailed: false,
  };
  let busy = false;
  let pending: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  function run(action: () => Promise<void>) {
    if (closing || busy)
      return Promise.reject(new Error('Agent access is busy.'));
    busy = true;
    const result = (async () => {
      try {
        await action();
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
  async function connect(selected?: number) {
    const state = status();
    const limitCents = selected ?? state.limitCents - state.spentCents;
    if (
      !validPaypalAgentSpendLimit(limitCents) ||
      closing ||
      busy ||
      access.disconnecting ||
      access.disconnectFailed ||
      state.phase !== PAYPAL_SESSION_PHASE.ACTIVE ||
      state.expired ||
      state.remainingAttempts === 0 ||
      state.spentCents >= state.limitCents
    )
      throw new Error('An active sandbox session is required.');
    return snapshot(
      await ensureEndpoint(access, () => start(limitCents)),
      status(),
      access.disconnecting,
      access.disconnectFailed,
      isSessionBusy(),
    );
  }
  function disconnect() {
    return run(() => disconnectEndpoint(access));
  }
  function close() {
    if (!closing) {
      closing = (async () => {
        await pending;
        const endpoint = access.opening
          ? await access.opening.catch(() => undefined)
          : undefined;
        await endpoint?.close();
      })();
    }
    return closing;
  }
  return {
    connect,
    disconnect,
    close,
    status: () => currentSnapshot(access, status, isSessionBusy),
    copyKey: (write: (secret: string) => void) =>
      copyEndpointKey(access, !!closing, write),
  };
}
