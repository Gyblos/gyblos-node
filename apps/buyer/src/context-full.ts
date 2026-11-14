// A seller's own refusal of a conversation it cannot fit (its input plus the answer limit over its context),
// sent back before any output: nothing was generated or charged, so a client that can shorten the
// conversation (Codex compacts it) may try again.
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import type { FreeExecutionStop } from '@gyblos/protocol/free-execution';

export const sellerContextFull = (view: {
  code: string;
  stop: FreeExecutionStop;
}) => view.code === FREE_EXECUTION_CODES.LIMIT && !view.stop.delivered;
