// Mounts either the simulated buyer UI or the existing isolated compatibility smoke.
// The normal Chat/Connect flow never invokes the native probe or any product service.
import { createRoot } from 'react-dom/client';

import { CompatibilityView } from './compatibility-view.js';
import { DesktopApp } from './desktop-app.js';

import './mockup-base.css';
import './ui/motion.css';
import './ui/ui.css';
import './ui/geometry.css';
import './ui/chat.css';
import './ui/signal.css';
import './ui/dropdown.css';
import './desktop-shell.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing desktop root.');
createRoot(root).render(
  new URLSearchParams(window.location.search).get('probe') === '1' ? (
    <CompatibilityView />
  ) : (
    <DesktopApp />
  ),
);
