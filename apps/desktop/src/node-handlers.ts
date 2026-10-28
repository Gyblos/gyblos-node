// Authorizes fixed status/retry IPC operations for the current main frame only.
import { LOCAL_NODE_STATE, type LocalNodeState } from './node-status';

interface NodeSession {
  summary(): LocalNodeState;
  start(): void;
}
interface NodeWindow {
  contents: unknown;
  mainFrame(): unknown;
  destroyed(): boolean;
}
interface NodeSender {
  sender: unknown;
  senderFrame: unknown;
}
export function createNodeHandlers(
  _session: NodeSession | null,
  _window: NodeWindow,
) {
  return {
    summary: (_event: NodeSender, _args: readonly unknown[]): LocalNodeState =>
      LOCAL_NODE_STATE.ERROR,
    retry: (_event: NodeSender, _args: readonly unknown[]): LocalNodeState =>
      LOCAL_NODE_STATE.ERROR,
  };
}
