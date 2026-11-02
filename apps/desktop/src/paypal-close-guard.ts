// Stops ordinary shutdown while an in-process response still needs acknowledgement.
import { waitForWalletBeforeQuit } from './wallet/lifecycle';

export function createDesktopPaypalCloseGuard(
  blocked: () => boolean,
  notify: () => void,
) {
  return (event: { preventDefault(): void }) => {
    if (!blocked()) return false;
    event.preventDefault();
    notify();
    return true;
  };
}

export function createDesktopQuitCoordinator(
  guard: (event: { preventDefault(): void }) => boolean,
  settle: () => Promise<unknown>,
  quit: () => void,
) {
  const finish = waitForWalletBeforeQuit(settle, quit);
  return (event: { preventDefault(): void }) => {
    if (!guard(event)) finish(event);
  };
}
