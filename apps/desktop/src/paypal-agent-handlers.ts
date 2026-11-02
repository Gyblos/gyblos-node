// Restricts sandbox agent setup to the desktop main frame.
import type { createDesktopPaypalAgentAccess } from './paypal-agent-access';
import {
  agentFailure,
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_ERROR,
  PaypalAgentConnectionError,
  type PaypalAgentAction,
  type PaypalAgentResult,
} from './paypal-agent-model';

type Access = ReturnType<typeof createDesktopPaypalAgentAccess>;
type Window = { contents: unknown; mainFrame(): unknown; destroyed(): boolean };
type Sender = { sender: unknown; senderFrame: unknown };

function action(value: unknown): PaypalAgentAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const row = Object.fromEntries(Object.entries(value));
  if (Object.keys(row).join(',') !== 'action') return undefined;
  return Object.values(PAYPAL_AGENT_ACTION).find(
    (entry) => entry === row.action,
  );
}

export function createDesktopPaypalAgentHandlers(
  load: () => Promise<{ agentAccess: Access }>,
  window: Window,
  current?: () => { agentAccess: Access } | null,
) {
  return {
    async run(
      event: Sender,
      args: readonly unknown[],
    ): Promise<PaypalAgentResult> {
      if (
        window.destroyed() ||
        event.sender !== window.contents ||
        event.senderFrame !== window.mainFrame() ||
        args.length !== 1
      )
        return agentFailure(PAYPAL_AGENT_ERROR.DENIED);
      const request = action(args[0]);
      if (!request) return agentFailure(PAYPAL_AGENT_ERROR.INVALID);
      if (request === PAYPAL_AGENT_ACTION.STATUS)
        return {
          connection: current?.()?.agentAccess.status() ?? null,
          error: null,
        };
      let access: Access;
      try {
        access = (await load()).agentAccess;
      } catch {
        return agentFailure(PAYPAL_AGENT_ERROR.UNAVAILABLE);
      }
      try {
        switch (request) {
          case PAYPAL_AGENT_ACTION.CONNECT:
            await access.connect();
            break;
          case PAYPAL_AGENT_ACTION.DISCONNECT:
            await access.disconnect();
            break;
        }
        return { connection: access.status(), error: null };
      } catch (error) {
        if (error instanceof PaypalAgentConnectionError)
          return agentFailure(error.code);
        return agentFailure();
      }
    },
  };
}
