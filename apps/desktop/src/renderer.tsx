// Mounts the buyer UI or the existing isolated compatibility smoke.
// USDC Chat/Connect remain simulated; PayPal Sandbox uses the local inference service.
import { createRoot } from 'react-dom/client';

import { CompatibilityView } from './compatibility-view';
import { STARTUP_WINDOW } from './constants';
import { DesktopApp } from './desktop-app';
import { StartupSplash } from './ui/StartupSplash';
import { DesktopWalletProvider } from './ui/WalletState';

import './ui/buyer-styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing desktop root.');
createRoot(root).render(
  new URLSearchParams(window.location.search).get(STARTUP_WINDOW.QUERY) ===
    STARTUP_WINDOW.QUERY_VALUE ? (
    <StartupSplash />
  ) : new URLSearchParams(window.location.search).get('probe') === '1' ? (
    <CompatibilityView />
  ) : (
    <DesktopWalletProvider>
      <DesktopApp />
    </DesktopWalletProvider>
  ),
);
