// Versioned duplex checkpoints reuse native cumulative vouchers, not per-block transactions.
import { BATCH_CHANNEL } from './constants';

export const SESSION_BLOCKS = {
  version: 5,
  alpn: 'gyblos/session/5',
  digestDomain: 'gyblos/session-block/v5\n',
  requestDomain: 'gyblos/session-request/v5\n',
  frameBytes: BATCH_CHANNEL.responseBytes,
  maxBlocks: BATCH_CHANNEL.maxOutputTokens + 1,
} as const;

export const SESSION_BLOCK_KINDS = {
  CHECKPOINT: 'checkpoint',
  APPROVAL: 'approval',
  ACK: 'ack',
  FAILURE: 'failure',
} as const;
