// Backpressures session RPC admission within the caller's original ingress deadline; never retries a request.
import { setTimeout as delay } from 'node:timers/promises';

import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import type { ControlAdmission } from '@gyblos/core/control-admission';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

export async function admitBatchQuery(
  admission: ControlAdmission,
  peer: string,
  signal: AbortSignal,
) {
  const connection = admission.openConnection(peer);
  try {
    for (;;) {
      signal.throwIfAborted();
      try {
        connection.beginQuery().finish();
        return;
      } catch (error) {
        if (
          !(error instanceof ControlError) ||
          error.code !== CONTROL_CODES.LIMIT
        )
          throw error;
      }
      // Recheck the actual bucket; waiting neither grants a token nor resets a rate/deadline.
      await delay(
        Math.ceil(
          CONTROL_CAPACITY.millisecondsPerSecond /
            Math.min(CONTROL_CAPACITY.globalRate, CONTROL_CAPACITY.peerRate),
        ),
        undefined,
        { signal },
      );
    }
  } finally {
    connection.close();
  }
}
