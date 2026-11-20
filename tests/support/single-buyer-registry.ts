// Adapts a synthetic single-buyer ledger to the same registry port as a production seller.
import assert from 'node:assert/strict';

import type {
  BatchSellerBackend,
  BatchSellerRegistry,
} from '@gyblos/payments-upto/batch-session';

export function singleBuyerRegistry(
  buyerNodeId: string,
  backend: BatchSellerBackend,
): BatchSellerRegistry {
  return {
    async list() {
      const stored = await backend.inspect();
      return stored ? [{ buyerNodeId, stored }] : [];
    },
    async permits(peer) {
      return peer === buyerNodeId;
    },
    backend(peer) {
      assert.equal(peer, buyerNodeId);
      return backend;
    },
    async dispose() {},
  };
}
