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
    '  const previewFunds = usePreviewFunds(model, !usingPaypal);\n  const canSend =\n    !previewFunds.blocked &&\n    !limitNotice &&',
  ],
  [
    '          <ChatComposer\n            disabled={loadingHistory}',
    '          <PreviewComposerTab funds={previewFunds} models={models} buyer={x402} onSelectModel={onSelectModel} />\n          <ChatComposer\n            disabled={loadingHistory}',
  ],
  [
    '            {limitNotice ||',
    "            {(previewFunds.blocked ? 'Add funds or choose a free model to send.' : limitNotice) ||",
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
    'const width = Math.min(\n        MENU_GEOMETRY.WIDTH,\n        window.innerWidth - gutter * 2,\n      );',
    "const split = menu.dataset.split === 'true';\n      const width = Math.min(\n        MENU_GEOMETRY.WIDTH,\n        split ? (window.innerWidth - gutter * 2 - 6) / 2 : window.innerWidth - gutter * 2,\n      );",
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
