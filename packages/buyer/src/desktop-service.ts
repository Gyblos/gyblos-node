// Owns a buyer sidecar lifetime. Credentials cross only its private parent port, never stdout.
import {
  BUYER_SIDECAR,
  isBuyerSessionConfigFailure,
} from '@gyblos/protocol/buyer-api';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}
interface Host {
  url: string;
  pauseWhenIdle?(): boolean;
  close(): Promise<void>;
}
export async function runBuyerSidecar(
  port: ParentPort,
  start: () => Promise<Host>,
  token: () => Promise<string>,
  exit: (code: number) => void,
) {
  let stopping = false;
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let host: Host | undefined;
  port.on('message', (event) => {
    if (event.data === BUYER_SIDECAR.STOP_IF_IDLE) {
      const idle = host?.pauseWhenIdle?.();
      port.postMessage({
        kind: idle ? BUYER_SIDECAR.IDLE : BUYER_SIDECAR.BUSY,
      });
      if (!idle) return;
    } else if (event.data !== BUYER_SIDECAR.STOP) return;
    stopping = true;
    stop();
  });
  let code = 0;
  try {
    host = await start();
    if (!stopping) {
      const bearer = await token();
      if (!stopping)
        port.postMessage({
          kind: BUYER_SIDECAR.READY,
          url: host.url,
          token: bearer,
        });
    }
    await stopped;
  } catch (error) {
    code = 1;
    try {
      const reason =
        error instanceof Error && 'reason' in error ? error.reason : undefined;
      const kind = isBuyerSessionConfigFailure(reason)
        ? reason
        : BUYER_SIDECAR.ERROR;
      port.postMessage({ kind });
    } catch {
      /* Parent already exited. */
    }
  } finally {
    try {
      await host?.close();
    } catch {
      code = 1;
    }
    exit(code);
  }
}
