// The length prefix of the next streamed event. The seller may stay silent while it reads a long prompt
// or prepares a tool call, so the wait for an event is bounded by the request budget; once an event
// begins, a partial prefix must meet the ingress deadline. An early end keeps the exact-read failure.
import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';

import { IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';

export async function readEventPrefix(
  stream: ControlStream,
  check: () => void,
  stage: <T>(operation: Promise<T>, milliseconds: number) => Promise<T>,
) {
  const first = await stage(stream.recv.read(1), TRANSPORT_TIMEOUTS.requestMs);
  check();
  const prefix = new Uint8Array(CONTROL_LIMITS.prefixBytes);
  prefix.set(first);
  prefix.set(
    await stage(
      stream.recv.readExact(CONTROL_LIMITS.prefixBytes - first.length),
      IROH_DEADLINES.ingressMs,
    ),
    first.length,
  );
  return prefix;
}
