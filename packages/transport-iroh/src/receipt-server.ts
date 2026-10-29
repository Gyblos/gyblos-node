// Serves one canonical receipt RPC per stream after endpoint admission; no HTTP or inference forwarding.
import type { Connection } from '@number0/iroh';

import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { ControlAdmission } from '@gyblos/core/control-admission';
import { RECEIPT_CHANNEL } from '@gyblos/protocol/constants';
import { controlInteger } from '@gyblos/protocol/control-validation';

import { HTTP_OVER_IROH } from './constants';
import {
  controlDeadline,
  readControlFrame,
  writeControlFrame,
  type ControlStream,
} from './control-io';
import { handleIrohConnection } from './iroh-connection';
import type { ReceiptService } from './receipt-service';

async function receiptStream(
  service: ReceiptService,
  queryMs: number,
  io: ControlStream,
  session: ReturnType<ControlAdmission['openConnection']>,
  peer: string,
  signal: AbortSignal,
  enter: () => (() => void) | undefined,
  allowed: () => boolean,
  close: () => void,
) {
  const release = enter();
  if (!release) {
    close();
    return;
  }
  let lease: ReturnType<typeof session.beginQuery> | undefined;
  try {
    lease = session.beginQuery();
    const admitted = lease;
    await controlDeadline(
      async (deadline) => {
        const request = await readControlFrame(io, RECEIPT_CHANNEL.frameBytes);
        admitted.check();
        const response = await service.respond(request, peer, deadline);
        if (deadline.aborted || !allowed()) {
          close();
          return;
        }
        await writeControlFrame(
          io,
          admitted.publish(response),
          RECEIPT_CHANNEL.frameBytes,
        );
        if (!allowed()) close();
      },
      queryMs,
      close,
      signal,
    );
  } catch {
    close();
  } finally {
    lease?.cancel();
    release();
  }
}
export function createReceiptServer(
  service: ReceiptService,
  now: () => number = () => performance.now(),
  queryMs: number = CONTROL_CAPACITY.queryMs,
) {
  const milliseconds = controlInteger(queryMs, 1, CONTROL_CAPACITY.queryMs);
  const stream = receiptStream.bind(undefined, service, milliseconds);
  const admission = new ControlAdmission(now); // Independent receipt budget; values intentionally reuse the control policy.

  return {
    // Exposed for deterministic stream/timeout contract tests; caller must still apply endpoint admission first.
    admission,
    serveStream: stream,
    async handle(
      connection: Connection,
      signal: AbortSignal,
      enter: () => (() => void) | undefined,
      closed: () => boolean,
      allowed: () => boolean,
    ) {
      const peer = connection.remoteId().toString();
      const session = admission.openConnection(peer);
      const close = () => connection.close(HTTP_OVER_IROH.streamCloseCode, []);
      try {
        await handleIrohConnection(
          connection,
          (io) => stream(io, session, peer, signal, enter, allowed, close),
          closed,
          {
            idleMs: CONTROL_CAPACITY.connectionIdleMs,
            receiveBytes: RECEIPT_CHANNEL.frameBytes,
          },
        );
      } finally {
        session.close();
        close();
      }
    },
  };
}
