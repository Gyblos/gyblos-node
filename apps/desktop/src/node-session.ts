// Owns one local-node process until its actual exit; never reads wallets or node configuration.
import {
  LOCAL_NODE,
  LOCAL_NODE_STATE,
  type LocalNodeState,
} from './node-status';
import type { ProbeWorker } from './probe-session';

function startNodeWorker(
  worker: ProbeWorker,
  update: (state: LocalNodeState) => void,
  onExit: () => void,
) {
  let spawned = false;
  let stopping = false;
  let failed = false;
  let exited = false;
  let finish = () => {};
  const exit = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fail = () => {
    if (exited) return;
    failed = true;
    update(LOCAL_NODE_STATE.ERROR);
    worker.kill();
  };
  let deadline = setTimeout(fail, LOCAL_NODE.START_TIMEOUT_MS);
  const requestStop = () => {
    try {
      worker.postMessage(LOCAL_NODE.STOP);
    } catch {
      fail();
    }
  };
  worker.on('spawn', () => {
    spawned = true;
    if (failed) worker.kill();
    else if (stopping) requestStop();
  });
  worker.on('message', (message) => {
    if (exited || stopping || failed) return;
    if (message !== LOCAL_NODE.READY) {
      fail();
      return;
    }
    clearTimeout(deadline);
    update(LOCAL_NODE_STATE.READY);
  });
  worker.on('exit', (code) => {
    if (exited) return;
    exited = true;
    clearTimeout(deadline);
    update(
      stopping && !failed && code === 0
        ? LOCAL_NODE_STATE.STOPPED
        : LOCAL_NODE_STATE.ERROR,
    );
    onExit();
    finish();
  });
  return {
    exit,
    stop() {
      if (exited || stopping) return;
      stopping = true;
      clearTimeout(deadline);
      if (!failed) update(LOCAL_NODE_STATE.STOPPING);
      deadline = setTimeout(fail, LOCAL_NODE.STOP_TIMEOUT_MS);
      if (spawned && !failed) requestStop();
    },
  };
}
export function createDesktopNodeSession(
  fork: () => ProbeWorker,
  signal: AbortSignal,
) {
  let state: LocalNodeState = LOCAL_NODE_STATE.STOPPED;
  let active: ReturnType<typeof startNodeWorker> | null = null;
  let closing = signal.aborted;
  function close() {
    closing = true;
    signal.removeEventListener('abort', abort);
    active?.stop();
    return active?.exit ?? Promise.resolve();
  }
  function abort() {
    void close();
  }
  signal.addEventListener('abort', abort, { once: true });
  return {
    summary: () => state,
    start() {
      if (closing || active) return;
      state = LOCAL_NODE_STATE.STARTING;
      try {
        active = startNodeWorker(
          fork(),
          (next) => {
            state = next;
          },
          () => {
            active = null;
          },
        );
      } catch {
        state = LOCAL_NODE_STATE.ERROR;
      }
      if (signal.aborted) void close();
    },
    close,
  };
}
