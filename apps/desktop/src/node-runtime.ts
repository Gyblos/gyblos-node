// Drives the local endpoint lifecycle without importing native bindings or Electron.
import type { NodeHost } from '@gyblos/node/lifecycle';

export interface LocalNodePort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: string): void;
}
export async function runLocalNode(_port: LocalNodePort, _bind: () => Promise<NodeHost>, _exit: (code: number) => void) {}
