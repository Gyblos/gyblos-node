// A readable message for a seller whose engine ran out of time, in every chat format and both for a JSON
// error and a stream's error event; undefined leaves the code as the message. Text delivered first means
// the seller read the prompt and could not finish; none means it could not read a request this size.
import { FREE_EXECUTION_STOP_REASONS } from '@gyblos/protocol/constants';
import type { FreeExecutionStop } from '@gyblos/protocol/free-execution';

import { FREE_CHAT_DETAILS } from './chat-constants';

export function slowSellerMessage(stop: FreeExecutionStop): string | undefined {
  if (stop.reason !== FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT)
    return undefined;
  return stop.delivered
    ? FREE_CHAT_DETAILS.sellerTooSlowToFinish
    : FREE_CHAT_DETAILS.sellerTooSlowToRead;
}
