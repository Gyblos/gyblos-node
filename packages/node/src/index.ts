// Owns the default seller composition behind the small node lifecycle API.
// Importing the library must not start engines, read wallets or open sockets.

import { createNodeLifecycle } from './lifecycle';
import { startSeller } from './seller';
import { sellerChainPayments } from './seller-chain';

// Paid offers sell on devnet through the role's payment keys; a free-only seller never opens them.
export function createNode(options: Parameters<typeof startSeller>[0] = {}) {
  return createNodeLifecycle(() =>
    startSeller({
      ...options,
      payments: options.payments ?? sellerChainPayments(),
    }),
  );
}
