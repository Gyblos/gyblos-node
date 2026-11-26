import { readFileSync } from 'node:fs';

import { replaceOnce } from './brand-replace';

// Preview-only Models screen: one synthetic row per model with its seller detail dialog.
export function previewModels(source: string): string {
  const models = replaceOnce(
    source,
    'const [network, setNetwork] = useState(false)',
    "const [network, setNetwork] = useState(() => new URLSearchParams(location.search).get('review') === 'network')",
  );
  const listStart = models.indexOf('      {canSelect ? (');
  const listEnd = models.indexOf(
    '      {!canSelect && (\n        <p',
    listStart,
  );
  if (listStart < 0 || listEnd < 0)
    throw new Error('Missing model catalog review hook');
  const catalog =
    models.slice(0, listStart) +
    '      <PreviewCatalog query={query} filter={filter} selected={selected} canSelect={canSelect} onSelect={onSelect} />\n' +
    models.slice(listEnd);
  const row = catalog.indexOf('function PreviewRows(');
  if (row < 0) throw new Error('Missing model rows review hook');
  return (
    "import { CaretRight, Check, PushPin, Shuffle } from '@phosphor-icons/react';\nimport { usdPerMtok } from './model-price';\nimport { comparableMedian, feeLabel, Notice, PREVIEW_COPY, previewSetting, READY_SELLER_MODES, Savings, SELLER_MODES, Tag, TONE, type SellerMode } from './PreviewKit';\nimport { BUTTON_VARIANT, MODEL_CATEGORY } from './constants';\nimport { HISTORY } from './history-constants';\nimport { Pagination } from './Pagination';\nimport { IconButton } from './UI';\nimport { MotionPresence } from './Motion';\n" +
    catalog.slice(0, row) +
    readFileSync(
      new URL('./views/ModelRow.tsx.preview', import.meta.url),
      'utf8',
    )
  );
}
