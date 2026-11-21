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
export const CHAT_TOOLS_REWRITES: readonly [string, string][] = [
  [
    "import { Check, Wrench } from '@phosphor-icons/react';",
    "import { Check, Plus } from '@phosphor-icons/react';",
  ],
  [
    'trigger={<Wrench size={16} aria-hidden="true" />}',
    'trigger={<Plus size={16} weight="bold" aria-hidden="true" />}',
  ],
];
