// Bounds status polling to one request and marks a slow response as unknown.
// It does not start a sandbox service or retain connection details.
export function createPaypalAgentStatusPoll<T>(
  request: () => Promise<T>,
  received: (value: T) => void,
  unavailable: () => void,
  timeoutMs: number,
) {
  let pending = false;
  let stalled = false;
  let stopped = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function poll() {
    if (pending || stopped) return;
    pending = true;
    stalled = false;
    deadline = setTimeout(() => {
      stalled = true;
      if (!stopped) unavailable();
    }, timeoutMs);
    void Promise.resolve()
      .then(request)
      .then(
        (value) => {
          if (!stopped) received(value);
        },
        () => {
          if (!stopped) unavailable();
        },
      )
      .finally(() => {
        clearTimeout(deadline);
        pending = false;
        stalled = false;
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
