// Owns one local agent endpoint for the lifetime of the desktop sandbox session.
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';

type Endpoint = {
  url: string;
  key: string;
  model: string;
  isCurrent(): boolean;
  isBusy(): boolean;
  close(): Promise<void>;
};

type SessionStatus = {
  phase: unknown;
  expired: boolean;
  spentCents: number;
  limitCents: number;
  remainingAttempts: number;
};
function snapshot(
  endpoint: Endpoint,
  state: SessionStatus,
  disconnecting: boolean,
) {
  return {
    url: endpoint.url,
    key: endpoint.key,
    model: endpoint.model,
    spentCents: state.spentCents,
    limitCents: state.limitCents,
    disconnecting,
    usageUncertain:
      disconnecting ||
      endpoint.isBusy() ||
      state.phase !== PAYPAL_SESSION_PHASE.ACTIVE ||
      state.expired ||
      state.remainingAttempts === 0 ||
      state.spentCents >= state.limitCents,
  };
}

type EndpointState = {
  current: Endpoint | undefined;
  opening: Promise<Endpoint> | undefined;
  disconnecting: boolean;
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

export function createDesktopPaypalAgentAccess(
  status: () => SessionStatus,
  start: () => Promise<Endpoint>,
) {
  const access: EndpointState = {
    opening: undefined,
    current: undefined,
    disconnecting: false,
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
  async function connect() {
    const state = status();
    if (
      closing ||
      busy ||
      access.disconnecting ||
      state.phase !== PAYPAL_SESSION_PHASE.ACTIVE ||
      state.expired ||
      state.remainingAttempts === 0 ||
      state.spentCents >= state.limitCents
    )
      throw new Error('An active sandbox session is required.');
    return snapshot(await ensureEndpoint(access, start), status(), false);
  }
  function disconnect() {
    return run(async () => {
      const endpoint = access.opening ? await access.opening : undefined;
      access.disconnecting = !!endpoint;
      await endpoint?.close();
      access.opening = undefined;
      access.current = undefined;
      access.disconnecting = false;
    });
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
    status: () =>
      access.current && (access.current.isCurrent() || access.disconnecting)
        ? snapshot(access.current, status(), access.disconnecting)
        : null,
  };
}
