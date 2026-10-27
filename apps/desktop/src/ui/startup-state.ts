// Startup readiness combines public wallet state and the existing network simulation.
// A storage failure may exit startup; it never authorizes funds or marks a backup.
import { WALLET_STATUS, type WalletSummary } from '../wallet/model';
import { NETWORK_STATE } from './constants';

export { NETWORK_STATE } from './constants';

export function startupPending(
  wallet: WalletSummary,
  network: (typeof NETWORK_STATE)[keyof typeof NETWORK_STATE],
) {
  return (
    wallet.status === WALLET_STATUS.LOADING ||
    network === NETWORK_STATE.CONNECTING
  );
}
