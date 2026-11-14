// Owns a buyer sidecar lifetime. Credentials cross only its private parent port, never stdout.
import { BUYER_SIDECAR } from '@gyblos/protocol/buyer-api';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}
interface Host {
  url: string;
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
  port.on('message', (event) => {
    if (event.data === BUYER_SIDECAR.STOP) {
      stopping = true;
      stop();
    }
  });
  let host: Host | undefined;
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
  } catch {
    code = 1;
    try {
      port.postMessage({ kind: BUYER_SIDECAR.ERROR });
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
