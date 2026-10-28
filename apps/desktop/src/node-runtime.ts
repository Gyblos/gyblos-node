// Drives the local endpoint lifecycle without importing native bindings or Electron.
import { createNodeLifecycle, type NodeHost } from '@gyblos/node/lifecycle';

import { LOCAL_NODE } from './node-status';

export interface LocalNodePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: string): void;
}
export async function runLocalNode(
  port: LocalNodePort,
  bind: () => Promise<NodeHost>,
  exit: (code: number) => void,
) {
  const lifecycle = createNodeLifecycle(bind);
  let stopping = false;
  const stopped = new Promise<void>((resolve) => {
    port.on('message', (event) => {
      if (event.data !== LOCAL_NODE.STOP) return;
      stopping = true;
      resolve();
    });
  });
  let code = 0;
  try {
    await lifecycle.start();
    if (!stopping) port.postMessage(LOCAL_NODE.READY);
    await stopped;
  } catch {
    code = 1;
  }
  try {
    await lifecycle.stop();
  } catch {
    code = 1;
  }
  exit(code);
}
