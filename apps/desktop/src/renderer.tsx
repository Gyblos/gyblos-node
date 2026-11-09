// Mounts the buyer UI or the existing isolated compatibility smoke.
// USDC Chat/Connect remain simulated; PayPal Sandbox uses the local inference service.
import { createRoot } from 'react-dom/client';

import { CompatibilityView } from './compatibility-view';
import { STARTUP_WINDOW } from './constants';
import { DesktopApp } from './desktop-app';
import { StartupSplash } from './ui/StartupSplash';
import { DesktopWalletProvider } from './ui/WalletState';

import './mockup-base.css';
import './ui/activity.css';
import './ui/appearance.css';
import './ui/buyer-design.css';
import './ui/chat.css';
import './ui/dropdown.css';
import './ui/geometry.css';
import './ui/icon-motion.css';
import './ui/motion.css';
import './ui/network-status.css';
import './ui/paypal-agent.css';
import './ui/signal.css';
import './ui/startup-splash.css';
import './ui/ui.css';

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
