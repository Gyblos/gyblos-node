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
    '          <PreviewComposerTab funds={previewFunds} funding={funding} models={models} onSelectModel={onSelectModel} checking={active && usingX402 && !!payer && loading} />\n          <ChatComposer\n            disabled={loadingHistory}',
  ],
  [
    '            {limitNotice ||',
    "            {(previewFunds.blocked ? 'Add funds or choose a free model to send.' : previewFunds.fallback && !previewHardNotice ? undefined : limitNotice) ||",
  ],
];
