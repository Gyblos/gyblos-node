// Mounts the buyer UI or the existing isolated compatibility smoke.
// Live Chat paths use the guarded PayPal coordinator or automatically prepared local buyer.
import { createRoot } from 'react-dom/client';

import { CompatibilityView } from './compatibility-view';
import { STARTUP_WINDOW } from './constants';
import { DesktopApp } from './desktop-app';
import { restoreInterfaceFont } from './ui/interface-font';
import { StartupSplash } from './ui/StartupSplash';
import { DesktopWalletProvider } from './ui/WalletState';

import './ui/buyer-styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing desktop root.');
restoreInterfaceFont();
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
