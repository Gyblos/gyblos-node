// Public synthetic checkpoint values; no real identities, content or vouchers.
import { SESSION_BLOCK_KINDS, SESSION_BLOCKS } from '@gyblos/protocol/session-blocks';

export const binding = {
  version: SESSION_BLOCKS.version,
  channelId: '11111111111111111111111111111111',
  requestId: '11'.repeat(16),
  requestDigest: '22'.repeat(32),
  index: 0,
};
export const block = {
  ...binding,
  kind: SESSION_BLOCK_KINDS.CHECKPOINT,
  text: 'a',
  usage: { inputTokens: 2, outputTokens: 1 },
  bill: {
    requestId: binding.requestId,
    requestDigest: binding.requestDigest,
    maxAtomic: '20',
    chargedAtomic: '3',
    cumulativeAtomic: '8',
  },
  terminal: null,
};
