// Bounds status polling and discards responses from requests that timed out.
// It does not start a sandbox service or retain connection details.
import { PAYPAL_STATUS_POLL_MAX_OUTSTANDING } from './constants';

export function createPaypalAgentStatusPoll<T>(
  request: () => Promise<T>,
  received: (value: T) => void,
  unavailable: () => void,
  timeoutMs: number,
) {
  let active: number | undefined;
  let counter = 0;
  let outstanding = 0;
  let stalled = false;
  let stopped = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function poll() {
    if (
      active !== undefined ||
      stopped ||
      outstanding >= PAYPAL_STATUS_POLL_MAX_OUTSTANDING
    )
      return;
    const id = ++counter;
    active = id;
    outstanding += 1;
    const timer = setTimeout(() => {
      if (stopped || active !== id) return;
      active = undefined;
      stalled = true;
      unavailable();
    }, timeoutMs);
    deadline = timer;
    let result: Promise<T>;
    try {
      result = request();
    } catch (error) {
      result = Promise.reject(error);
    }
    void result
      .then(
        (value) => {
          if (!stopped && active === id) {
            active = undefined;
            stalled = false;
            received(value);
          }
        },
        () => {
          if (!stopped && active === id) {
            active = undefined;
            stalled = true;
            unavailable();
          }
        },
      )
      .finally(() => {
        clearTimeout(timer);
        outstanding -= 1;
      })
      .catch(() => {});
  }
  return {
    poll,
    isStalled: () => stalled,
    stop() {
      stopped = true;
      clearTimeout(deadline);
    },
  };
}
