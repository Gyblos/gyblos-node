// Local transport and consumer provenance never changes signed execution errors on the wire.
import {
  FREE_EXECUTION_CODES,
  type FreeExecutionCode,
  type FreeExecutionStopReason,
} from '@gyblos/protocol/constants';
import {
  freeExecutionStop,
  type FreeExecutionDelivered,
  type FreeExecutionStop,
} from '@gyblos/protocol/free-execution';

import type { ControlStream } from './control-io';

export class FreeClientError extends Error {
  declare readonly reason?: FreeExecutionStopReason;
  declare readonly delivered?: FreeExecutionDelivered;
  constructor(
    readonly code: FreeExecutionCode,
    readonly sent: boolean,
    readonly remote = false,
    stop: FreeExecutionStop = {},
    readonly ioFailure = false,
    readonly consumerFailure = false,
  ) {
    super(code);
    this.name = 'FreeClientError';
    Object.assign(this, freeExecutionStop(stop));
  }
}
// Only SDK stream operations are transport faults. Validation and user callbacks stay outside.
export function freeClientIo(
  stream: ControlStream,
  sent: () => boolean,
): ControlStream {
  const io = async <T>(run: () => Promise<T>) => {
    try {
      return await run();
    } catch {
      throw new FreeClientError(
        FREE_EXECUTION_CODES.INTERNAL,
        sent(),
        false,
        {},
        true,
      );
    }
  };
  return {
    recv: {
      readExact: (size) => io(() => stream.recv.readExact(size)),
      read: (size) => io(() => stream.recv.read(size)),
    },
    send: {
      writeAll: (bytes) => io(() => stream.send.writeAll(bytes)),
      finish: () => io(() => stream.send.finish()),
    },
  };
}
