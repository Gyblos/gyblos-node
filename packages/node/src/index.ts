// Owns the default seller composition behind the small node lifecycle API.
// Importing the library must not start engines, read wallets or open sockets.
import { createNodeLifecycle } from './lifecycle';
import { startSeller } from './seller';

export function createNode() {
  return createNodeLifecycle(startSeller);
}
