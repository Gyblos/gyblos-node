// A readable message for a seller whose engine ran out of time, in every chat format and both for a JSON
// error and a stream's error event; undefined leaves the code as the message. Text delivered first means
// the seller read the prompt and could not finish; none means it could not read a request this size.
import {
  CONTROL_CODES,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import type { FreeExecutionStop } from '@gyblos/protocol/free-execution';

import { FREE_CHAT_DETAILS } from './chat-constants';

export function slowSellerMessage(stop: FreeExecutionStop): string | undefined {
  if (stop.reason !== FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT)
    return undefined;
  return stop.delivered
    ? FREE_CHAT_DETAILS.sellerTooSlowToFinish
    : FREE_CHAT_DETAILS.sellerTooSlowToRead;
}

// The plain reason a request found no seller, when every seller asked refused its quote for what the
// request needs: none serves its tools, or none of those that do reads a request this size in time. Any
// other answer (busy, gone, silent) leaves the usual error. Keyed by seller, its last refusal.
export function refusedDetail(
  refusals: ReadonlyMap<string, string>,
): string | undefined {
  const codes = [...refusals.values()];
  if (!codes.length) return undefined;
  if (codes.every((code) => code === CONTROL_CODES.TOOLS))
    return FREE_CHAT_DETAILS.noToolSeller;
  if (
    codes.every(
      (code) => code === CONTROL_CODES.TOOLS || code === CONTROL_CODES.TOO_SLOW,
    )
  )
    return FREE_CHAT_DETAILS.noFastSeller;
  return undefined;
}
