// Owns one local agent endpoint for the lifetime of the desktop sandbox session.
import { PAYPAL_SESSION_PHASE } from '@gyblos/node/constants';

type Endpoint = {
  url: string;
  key: string;
  model: string;
  hasPending(): boolean;
  acknowledgePending(): Promise<void>;
  close(): Promise<void>;
};

function snapshot(endpoint: Endpoint) {
  return {
    url: endpoint.url,
    key: endpoint.key,
    model: endpoint.model,
    pending: endpoint.hasPending(),
  };
}

export function createDesktopPaypalAgentAccess(
  status: () => { phase: unknown; expired: boolean },
  start: () => Promise<Endpoint>,
) {
  let opening: Promise<Endpoint> | undefined;
  let current: Endpoint | undefined;
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
      state.phase !== PAYPAL_SESSION_PHASE.ACTIVE ||
      state.expired
    )
      throw new Error('An active sandbox session is required.');
    if (!opening) {
      const next = Promise.resolve()
        .then(start)
        .then((endpoint) => {
          current = endpoint;
          return endpoint;
        })
        .catch((error: unknown) => {
          if (opening === next) opening = undefined;
          throw error;
        });
      opening = next;
    }
    return snapshot(await opening);
  }
  function confirm() {
    return run(async () => {
      if (!current || !current.hasPending())
        throw new Error('No agent response is available.');
      await current.acknowledgePending();
    });
  }
  function disconnect() {
    return run(async () => {
      const endpoint = opening ? await opening : undefined;
      if (endpoint?.hasPending())
        throw new Error('An agent response is pending.');
      await endpoint?.close();
      opening = undefined;
      current = undefined;
    });
  }
  function close() {
    if (!closing) {
      closing = (async () => {
        await pending;
        const endpoint = opening
          ? await opening.catch(() => undefined)
          : undefined;
        await endpoint?.close();
      })();
    }
    return closing;
  }
  return {
    connect,
    confirm,
    disconnect,
    close,
    status: () => (current ? snapshot(current) : null),
  };
}
