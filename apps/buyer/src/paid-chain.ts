// What the paid buyer's chain commands share: the buyer role from the home, and a failure's static
// code from the command's own table, never upstream text.
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { loadRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

// A failure's static code from a command's own table: what to fix before running it again.
export function paidChainFailure(
  error: unknown,
  codes: { NETWORK: string; ROLE: string; INCOMPLETE: string },
) {
  const code = error instanceof NodeError ? error.code : undefined;
  if (code === NODE_ERROR_CODES.BUYER_PAYMENT_NETWORK_MISMATCH)
    return codes.NETWORK;
  if (code === NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID) return codes.ROLE;
  return codes.INCOMPLETE;
}

export async function buyerRole() {
  try {
    return await loadRole(P2P_ROLES.BUYER);
  } catch {
    throw new NodeError(NODE_ERROR_CODES.BUYER_PAYMENT_KEY_INVALID);
  }
}
