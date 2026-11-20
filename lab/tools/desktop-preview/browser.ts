// Installs synthetic browser-only host adapters explicitly; importing this module has no side effects.
import { MAIN_NAV, UI_VIEW } from '@gyblos/desktop/catalog-state';

import { PREVIEW } from './constants';
import { createPreviewHost } from './host';
import type { AgentExamples } from './input';

export function startPreview(examples: AgentExamples) {
  Object.assign(window, createPreviewHost(location.search, examples));
  document.title = PREVIEW.title;
  const screen = new URLSearchParams(location.search).get('screen');
  const target =
    MAIN_NAV.find((item) => item.label.toLowerCase() === screen)?.label ??
    (screen === UI_VIEW.SETTINGS.toLowerCase() ? UI_VIEW.SETTINGS : undefined);
  if (!target || target === UI_VIEW.CHAT) return;
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
