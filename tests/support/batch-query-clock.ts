// Reproduces fast Linux query bursts with the real admission policy and a synthetic monotonic clock.
import type { TestContext } from 'node:test';

import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { ControlAdmission } from '@gyblos/core/control-admission';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

export function observeBatchQueryRefusals(
  t: TestContext,
  refused: () => void,
  before: () => void = () => {},
) {
  const open = ControlAdmission.prototype.openConnection;
  t.mock.method(
    ControlAdmission.prototype,
    'openConnection',
    function (this: ControlAdmission, peer: string) {
      const lease = open.call(this, peer);
      return {
        ...lease,
        beginQuery() {
          before();
          try {
            return lease.beginQuery();
          } catch (error) {
            if (
              error instanceof ControlError &&
              error.code === CONTROL_CODES.LIMIT
            ) {
              refused();
            }
            throw error;
          }
        },
      };
    },
  );
}

export function batchQueryClock(t: TestContext) {
  let now = 0;
  let attempts = 0;
  let refused = 0;
  const step =
    CONTROL_CAPACITY.millisecondsPerSecond / CONTROL_CAPACITY.peerRate;
  t.mock.method(performance, 'now', () => now);
  observeBatchQueryRefusals(
    t,
    () => {
      refused++;
      now += step;
    },
    () => {
      attempts++;
      // Permit the third EXECUTE, then exhaust the bucket at its following APPROVE.
      if (attempts === CONTROL_CAPACITY.peerBurst + 1) now += step;
    },
  );
  return { refused: () => refused };
}
