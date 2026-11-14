// Runtime capability checks keep existing session adapters usable without pretending they support blocks.
import type {
  SessionBuyer,
  SessionSeller,
} from '@gyblos/protocol/payment-session';
import type {
  SessionBlockBuyer,
  SessionBlockSeller,
} from '@gyblos/protocol/session-blocks';

export function isBlockBuyer(buyer: SessionBuyer): buyer is SessionBlockBuyer {
  return (
    'beginBlocks' in buyer &&
    typeof buyer.beginBlocks === 'function' &&
    'approveBlock' in buyer &&
    typeof buyer.approveBlock === 'function' &&
    'acknowledgeBlock' in buyer &&
    typeof buyer.acknowledgeBlock === 'function' &&
    'recoverBlockApproval' in buyer &&
    typeof buyer.recoverBlockApproval === 'function' &&
    'pendingBlockRequest' in buyer &&
    typeof buyer.pendingBlockRequest === 'function' &&
    'usesBlocks' in buyer &&
    typeof buyer.usesBlocks === 'function'
  );
}
export function isBlockSeller(
  seller: SessionSeller,
): seller is SessionBlockSeller {
  return (
    'reserveBlocks' in seller &&
    typeof seller.reserveBlocks === 'function' &&
    'checkpoint' in seller &&
    typeof seller.checkpoint === 'function' &&
    'acceptBlock' in seller &&
    typeof seller.acceptBlock === 'function' &&
    'releaseBlocks' in seller &&
    typeof seller.releaseBlocks === 'function' &&
    'resumeBlock' in seller &&
    typeof seller.resumeBlock === 'function'
  );
}
