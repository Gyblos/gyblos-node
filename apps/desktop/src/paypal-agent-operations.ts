// Serializes local agent grants and requests with the desktop payment session.
// A grant is immutable and bound to one freshly approved session, never persisted.
import { randomUUID } from 'node:crypto';

import type { createPaypalSession } from '@gyblos/node/paypal-session';

import { createPaypalAgentBudget } from './paypal-agent-budget';

type Session = Awaited<ReturnType<typeof createPaypalSession>>;
type Run = <T>(action: () => Promise<T>) => Promise<T>;
export function desktopPaypalAgentOperations(
  session: Session,
  run: Run,
  check: () => Promise<void>,
  orderId: () => string,
  scope: () => string | undefined,
) {
  const send = (
    input: unknown,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ) =>
    session.agentMessage(
      orderId(),
      input,
      randomUUID(),
      signal,
      idempotencyKey,
    );
  return {
    sendAgent: (
      input: unknown,
      signal?: AbortSignal,
      idempotencyKey?: string,
    ) =>
      run(async () => {
        await check();
        return send(input, signal, idempotencyKey);
      }),
    prepareAgent: () => run(check),
    createAgentGrant: (limitCents?: number) =>
      run(async () => {
        await check();
        const budget = createPaypalAgentBudget(
          () => ({
            ...session.status(),
            scope: scope(),
            activity: session.activity(),
          }),
          limitCents,
        );
        return {
          budget: budget.status,
          sendAgent: (
            input: unknown,
            signal?: AbortSignal,
            idempotencyKey?: string,
          ) =>
            run(async () => {
              await check();
              signal?.throwIfAborted();
              budget.authorize();
              return send(input, signal, idempotencyKey);
            }),
        };
      }),
  };
}
