import { readFileSync } from 'node:fs';

import { replaceOnce } from './brand-replace';

// Preview-only Models screen: one synthetic row per model with its seller detail dialog.
export function previewModels(source: string): string {
  const models = replaceOnce(
    source,
    'const [network, setNetwork] = useState(false)',
    "const [network, setNetwork] = useState(() => new URLSearchParams(location.search).get('review') === 'network')",
  );
  const listStart = models.indexOf('      <List label="Model catalog">');
  const listEnd = models.indexOf('      </List>', listStart);
  if (listStart < 0 || listEnd < 0)
    throw new Error('Missing model catalog review hook');
  const catalog = replaceOnce(
    replaceOnce(
      models.slice(0, listStart) +
        '      <List label="Model catalog">\n        <PreviewRows query={query} filter={filter} selected={selected} canSelect={canSelect} onSelect={onSelect} />\n' +
        models.slice(listEnd),
      '  selected: string;\n  onSelect(model: CatalogModel): void;\n}) {\n  const rows',
      '  selected: string;\n  canSelect: boolean;\n  onSelect(model: CatalogModel): void;\n}) {\n  const rows',
    ),
    '      canSelect={false}\n',
    '      canSelect={canSelect}\n',
  );
  const previewRows = replaceOnce(
    catalog,
    '  selected,\n  onSelect,\n}: {\n  query: string;',
    '  selected,\n  canSelect,\n  onSelect,\n}: {\n  query: string;',
  );
  const row = previewRows.indexOf('function ModelRow(');
  if (row < 0) throw new Error('Missing model row review hook');
  return (
    "import { CaretRight, Check } from '@phosphor-icons/react';\nimport { usdPerMtok } from './model-price';\nimport { comparableMedian, feeLabel, Notice, PREVIEW_COPY, previewSetting, READY_SELLER_MODES, Savings, SELLER_MODES, Tag, TONE, type SellerMode } from './PreviewKit';\nimport { BUTTON_VARIANT } from './constants';\nimport { MotionPresence } from './Motion';\n" +
    previewRows.slice(0, row) +
    readFileSync(
      new URL('./views/ModelRow.tsx.preview', import.meta.url),
      'utf8',
    )
  );
}
