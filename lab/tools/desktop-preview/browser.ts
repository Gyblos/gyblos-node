// Installs synthetic browser-only host adapters explicitly; importing this module has no side effects.
import { UI_VIEW } from '@gyblos/desktop/catalog-state';

import { PREVIEW } from './constants';
import { createPreviewHost } from './host';
import type { AgentExamples } from './input';

type View = (typeof UI_VIEW)[keyof typeof UI_VIEW];
const SCREEN_VIEW: Partial<Record<string, View>> = {
  chat: UI_VIEW.CHAT,
  connections: UI_VIEW.CONNECT,
  models: UI_VIEW.MODELS,
  applications: UI_VIEW.TOOLS,
  activity: UI_VIEW.ACTIVITY,
  payments: UI_VIEW.PAYMENTS,
  settings: UI_VIEW.SETTINGS,
  'design-system': UI_VIEW.SETTINGS,
};
declare global {
  interface Window {
    previewNavigate?: (view: View) => void;
  }
}
export function startPreview(examples: AgentExamples) {
  Object.assign(window, createPreviewHost(location.search, examples));
  document.title = PREVIEW.title;
  const query = new URLSearchParams(location.search);
  const compact = query.get('density') !== 'comfortable';
  if (compact) document.documentElement.dataset.density = 'compact';
  if (query.get('font') === 'inter' || (compact && !query.has('font')))
    document.documentElement.dataset.font = 'inter';
  const screen = query.get('screen') ?? '';
  const target = SCREEN_VIEW[screen];
  if (!target || target === UI_VIEW.CHAT) return;
  const observer = new MutationObserver(() => {
    if (!window.previewNavigate) return;
    observer.disconnect();
    window.previewNavigate(target);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
