// Installs synthetic browser-only host adapters explicitly; importing this module has no side effects.
import { MAIN_NAV } from '@gyblos/desktop/catalog-state';
import { AGENT_TOOLS } from '@gyblos/node/agent-setup-constants';

import { PREVIEW } from './constants';
import { createPreviewHost } from './host';

export function startPreview(
  examples: Record<(typeof AGENT_TOOLS)[keyof typeof AGENT_TOOLS], string>,
) {
  Object.assign(window, createPreviewHost(location.search, examples));
  document.title = PREVIEW.title;
  const screen = new URLSearchParams(location.search).get('screen');
  const target = MAIN_NAV.find(
    (item) => item.label.toLowerCase() === screen,
  )?.label;
  if (!target) return;
  const observer = new MutationObserver(() => {
    const button = Array.from(document.querySelectorAll('.ui-nav-row')).find(
      (item) => item.getAttribute('aria-label') === target,
    );
    if (button instanceof HTMLButtonElement) {
      observer.disconnect();
      button.click();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
