// Bounded buyer-local waiting; these defaults do not increase transport or execution capacity.
import { TRANSPORT_TIMEOUTS } from './transport';

export const BUYER_ROUTING_DEFAULTS = {
  queueWaitMs: 30000,
  queuePollMs: 2000,
  maxQueueWaitMs: TRANSPORT_TIMEOUTS.requestMs,
} as const;
