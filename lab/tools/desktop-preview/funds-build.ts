// Preview-only rewrites for the synthetic funds-needed flow: no balance check blocks with a modal.
export const APP_FUNDS_REWRITES: readonly [string, string][] = [
  [
    '    if (!next.free) {\n      setPaidModel(next);',
    '    if (!next.free && window.previewFunds?.atomic !== 0) {\n      setPaidModel(next);',
  ],
  [
    '      { credits, spent, budget },',
    '      { credits: Math.max(credits, (window.previewFunds?.atomic ?? 0) / 1_000_000), spent, budget },',
  ],
];
export const CHAT_FUNDS_REWRITES: readonly [string, string][] = [
  [
    "import { ChatComposer } from './ChatComposer';",
    "import { ChatComposer } from './ChatComposer';\nimport { PreviewComposerTab, usePreviewFunds } from './PreviewKit';",
  ],
  [
    '  const canSend =\n    !limitNotice &&',
    '  const previewFunds = usePreviewFunds(model, !usingPaypal, models);\n  // The free fallback only replaces funds and paid-terms notices; unfinished payments, expired listings and the wrong free listing still block.\n  const previewHardNotice =\n    usingX402 &&\n    (x402?.state.summary.blocked ||\n      freeListingMismatch ||\n      (model.source === MODEL_SOURCE.ANNOUNCED && !models.some((item) => item.id === model.id)));\n  const canSend =\n    !previewFunds.blocked &&\n    (previewFunds.fallback ? !previewHardNotice : !limitNotice) &&',
  ],
  [
    '          <ChatComposer\n            disabled={loadingHistory}',
    '          <PreviewComposerTab funds={previewFunds} models={models} onSelectModel={onSelectModel} />\n          <ChatComposer\n            disabled={loadingHistory}',
  ],
  [
    '            {limitNotice ||',
    "            {(previewFunds.blocked ? 'Add funds or choose a free model to send.' : previewFunds.fallback && !previewHardNotice ? undefined : limitNotice) ||",
  ],
];

export const MENU_REWRITES: readonly [string, string][] = [
  [
    "window.addEventListener('scroll', position, true);",
    "const outside = (event: Event) => {\n      if (!(event.target instanceof Node && menu.contains(event.target))) position();\n    };\n    window.addEventListener('scroll', outside, true);",
  ],
  [
    "window.removeEventListener('scroll', position, true);",
    "window.removeEventListener('scroll', outside, true);\n      menu.removeEventListener('preview:reposition', position);",
  ],
  [
    "window.addEventListener('resize', position);",
    "window.addEventListener('resize', position);\n    menu.addEventListener('preview:reposition', position);",
  ],
  [
    'menu.style.width = `min(var(--seller-menu-width, ${MENU_GEOMETRY.WIDTH}px), ${window.innerWidth - gutter * 2}px)`;',
    "const split = menu.dataset.split === 'true';\n      menu.style.width = split\n        ? `${Math.min(MENU_GEOMETRY.WIDTH, (window.innerWidth - gutter * 2 - 6) / 2)}px`\n        : `min(var(--seller-menu-width, ${MENU_GEOMETRY.WIDTH}px), ${window.innerWidth - gutter * 2}px)`;",
  ],
  [
    'const up =\n        below < Math.min(menu.scrollHeight, MENU_GEOMETRY.WIDTH) &&\n        above > below;',
    "const fits = (space: number) => space >= Math.min(menu.scrollHeight, MENU_GEOMETRY.WIDTH);\n      const up = anchor.closest('.composer')\n        ? fits(above) || above > below\n        : !fits(below) && above > below;",
  ],
  [
    'window.innerWidth - width - gutter',
    'window.innerWidth - width - (split ? width + 6 : 0) - gutter',
  ],
  [
    'menu.style.top = `${up ? bounds.top - gap - Math.min(menu.scrollHeight, available) : bounds.bottom + gap}px`;',
    "menu.style.top = up ? 'auto' : `${bounds.bottom + gap}px`;\n      menu.style.bottom = up ? `${window.innerHeight - bounds.top + gap}px` : 'auto';",
  ],
];
