// A seller's own refusal of a conversation it cannot fit (its input plus the answer limit over its context).
// Only for an error answered before any output: callers use it where nothing has been written to the client
// yet (a JSON error), never after a stream began, since a limit after text means a cut answer. The protocol
// carries no `delivered` with this code, so the check stays as a guard only.
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type { FreeExecutionStop } from '@gyblos/protocol/free-execution';

export const sellerContextFull = (view: {
  code: string;
  stop: FreeExecutionStop;
}) => view.code === FREE_EXECUTION_CODES.LIMIT && !view.stop.delivered;
