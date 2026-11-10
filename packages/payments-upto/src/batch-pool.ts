// Durable shared deposit accounting; no inference, wallet loading or operational submissions.
import { sessionFail } from '@gyblos/protocol/payment-session';

import type { BatchBuyerPool, BatchPoolOptions } from './batch-pool-types';

export function openBatchBuyerPool(_options: BatchPoolOptions): Promise<BatchBuyerPool> {
  return Promise.resolve(sessionFail());
}
export function inspectBatchPool(_paths: BatchPoolOptions['paths']) {
  return Promise.resolve([]);
}
