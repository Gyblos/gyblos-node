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
  session: NodeSession | null,
  window: NodeWindow,
) {
  const accepts = (event: NodeSender, args: readonly unknown[]) =>
    session !== null &&
    !window.destroyed() &&
    args.length === 0 &&
    event.sender === window.contents &&
    event.senderFrame === window.mainFrame();
  return {
    summary: (event: NodeSender, args: readonly unknown[]): LocalNodeState =>
      accepts(event, args) && session
        ? session.summary()
        : LOCAL_NODE_STATE.ERROR,
    retry: (event: NodeSender, args: readonly unknown[]): LocalNodeState => {
      if (!accepts(event, args) || !session) return LOCAL_NODE_STATE.ERROR;
      session.start();
      return session.summary();
    },
  };
}
