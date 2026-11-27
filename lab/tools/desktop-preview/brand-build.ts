// Applies the public brand and composer-copy proposals only to browser bundles, with portable IDs.
// Shipped desktop sources and operational configuration are never changed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { InlineConfig, Plugin } from 'vite';

import { transformCodeSamples } from './brand-code';
import { replaceEach, replaceOnce } from './brand-replace';
import brand from './brand.json' with { type: 'json' };
import * as funds from './funds-build';
import * as layout from './layout-build';
import { previewModels } from './models-build';

export { brand };
const moduleId = (value: string) => value.replaceAll('\\', '/');
export function transformBrand(source: string, id: string, desktop: string) {
  source = source.replaceAll('\r\n', '\n');
  const target = moduleId(id);
  const base = moduleId(desktop).replace(/\/$/, '');
  for (const component of [
    'DataTable',
    'ActivitySessions',
    'Activity',
    'X402Payments',
    'Payments',
    'SpendingHistory',
    'UsdcApiKeys',
    'UsdcApiKeyDetails',
    'ActivitySessionDetails',
    'ModelDropdown',
    'Settings',
    'SystemStatus',
  ]) {
    if (target === `${base}/src/ui/${component}.tsx`)
      return readFileSync(
        new URL(`./views/${component}.tsx.preview`, import.meta.url),
        'utf8',
      );
  }
  if (target === `${base}/src/ui/PaypalSessionPanel.tsx`) {
    return (
      "import { usageChange } from '../../../../lab/tools/desktop-preview/usage';\ndeclare global { interface Window { previewPaypalBaseline: ReturnType<typeof paypalPaymentSummary> } }\n" +
      replaceEach(source, [
        [
          'icon={Gauge}',
          'icon={Gauge} change={usageChange(summary.limitCents, window.previewPaypalBaseline.limitCents)} comparison="Since the preview opened"',
        ],
        [
          'icon={Receipt}',
          'icon={Receipt} comparison="Since the preview opened" change={summary.capturedCents !== null ? usageChange(summary.capturedCents, window.previewPaypalBaseline.capturedCents) : usageChange(summary.usedCents, window.previewPaypalBaseline.usedCents)}',
        ],
        [
          'icon={Wallet}',
          'icon={Wallet} change={usageChange(summary.remainingCents, window.previewPaypalBaseline.remainingCents)} comparison="Since the preview opened"',
        ],
      ])
    );
  }
  if (target === `${base}/src/ui/NetworkCatalog.tsx`) {
    const start = source.indexOf('export function NetworkCatalogPanel(');
    if (start < 0) throw new Error('Missing network catalog view hook');
    return (
      source.slice(0, start) +
      readFileSync(
        new URL('./views/NetworkSearch.tsx.preview', import.meta.url),
        'utf8',
      )
    );
  }
  if (target === `${base}/src/ui/Models.tsx`) return previewModels(source);
  if (target === `${base}/src/desktop-app.tsx`) {
    const routed = source.replace(
      /<Payments\s+key=\{view\}[\s\S]*?x402=\{x402\}\s+session=\{paypal\}/,
      "<Payments key={view} chat={chatController} initialTab={view === UI_VIEW.ACTIVITY ? 'activity' : undefined} selectedSession={activitySession} x402={x402} session={paypal}",
    );
    const footer = routed.replace(
      /<footer className="preview-status-bar"[\s\S]*?<\/footer>/,
      '<PreviewStatusBar version={manifest.version} status={<SystemStatus state={network.state} onRetry={network.retry} onPayments={() => navigate(UI_VIEW.PAYMENTS)} />} />',
    );
    const statusBar = replaceEach(footer, [
      [
        "import { PageBody } from './ui/PageBody';\n",
        "import { PageBody } from './ui/PageBody';\nimport { PreviewChatDetails, PreviewStatusBar } from './ui/PreviewKit';\n",
      ],
    ]);
    const funded = replaceEach(statusBar, [...funds.APP_FUNDS_REWRITES]);
    return replaceOnce(
      replaceOnce(
        funded,
        '  const navigation = MAIN_NAV;\n',
        '  const navigation = MAIN_NAV;\n  useEffect(() => { Object.assign(window, { previewNavigate: navigate }); });\n',
      ),
      'const [light, setLight] = useState(prefersLightTheme)',
      "const [light, setLight] = useState(() => new URLSearchParams(location.search).get('theme') === 'light')",
    );
  }
  if (target === `${base}/src/ui/BuyerSidebar.tsx`) {
    const start = source.indexOf('export function BuyerSidebar(');
    if (start < 0) throw new Error('Missing sidebar review hook');
    return (
      "import { PREVIEW_SHORTCUT, PreviewConversationPanel, previewCompact, previewShortcut } from './PreviewKit';\nimport type { ReactNode } from 'react';\n" +
      source.slice(0, start) +
      readFileSync(
        new URL('./views/BuyerSidebar.tsx.preview', import.meta.url),
        'utf8',
      )
    );
  }
  if (target === `${base}/src/ui/WindowTitlebar.tsx`)
    return replaceEach(
      replaceOnce(
        "import { PREVIEW_EVENT, PREVIEW_NETWORKS, PreviewConversationMenu, usePreviewConversationTitle, usePreviewNetwork, usePreviewSetting } from './PreviewKit';\n" +
          source +
          readFileSync(
            new URL('./views/NetworkSwitch.tsx.preview', import.meta.url),
            'utf8',
          ),
        '<PaymentNetworkLabel />',
        '<PreviewNetwork />',
      ),
      layout.TITLEBAR_REWRITES,
    );
  if (target === `${base}/src/x402-model.ts`)
    return replaceEach(source, [
      ["'USDC · devnet'", "'USDC'"],
      ['Only Solana devnet is supported', 'Unsupported payment network'],
      [
        'Connect a buyer with a devnet USDC channel configured in Payments.',
        'Connect a buyer with a testnet USDC channel configured in Usage & payments.',
      ],
      [
        "String(BigInt(atomic) % scale).padStart(DESKTOP_X402.ATOMIC_DECIMALS, '0')\n  );",
        "String(BigInt(atomic) % scale).padStart(DESKTOP_X402.ATOMIC_DECIMALS, '0')\n  ).replace(/0+$/, '').replace(/\\.$/, '');",
      ],
    ]);
  const codeSample = transformCodeSamples(source, target, base);
  if (codeSample !== undefined) return codeSample;
  if (target === `${base}/src/ui/BuyerFunding.tsx`)
    return source.replaceAll(
      'Could not open the devnet faucet.',
      'Could not open the testnet faucet.',
    );
  if (target === `${base}/src/ui/Chat.tsx`)
    return replaceEach(
      source.replace(
        /\{active && usingX402 && x402 && [\s\S]*?<ComposerFunding[\s\S]*?\/>(?:\s*\))?\}/,
        '',
      ),
      [
        ["'x402 · devnet'", "'x402'"],
        ["'Free · Gyblos network'", "''"],
        ...funds.CHAT_FUNDS_REWRITES,
      ],
    );
  if (target === `${base}/src/theme.ts`) {
    for (const [name, value] of Object.entries(brand.themeTokens)) {
      const pattern = new RegExp(`  ${name}: '[^']+',`);
      if (!pattern.test(source)) throw new Error('Missing desktop brand token');
      source = source.replace(pattern, `  ${name}: '${value}',`);
    }
    return source;
  }
}
// Browser-only modules that the preview kit imports beside the desktop sources.
const PREVIEW_KIT_HELPERS = [
  'code-highlight',
  'status-tone',
  'market',
] as const;

export function reviewBrand(desktop: string): Plugin {
  return {
    name: 'desktop-brand-review',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === undefined) return null;
      const from = moduleId(importer);
      const kit = `${moduleId(desktop)}/src/ui/PreviewKit.tsx`;
      if (
        (source === './PreviewKit' &&
          from.startsWith(`${moduleId(desktop)}/src/ui/`)) ||
        (source === './ui/PreviewKit' &&
          from === `${moduleId(desktop)}/src/desktop-app.tsx`)
      )
        return `${desktop}/src/ui/PreviewKit.tsx`;
      const helper = PREVIEW_KIT_HELPERS.find((name) => source === `./${name}`);
      if (helper && from === kit)
        return fileURLToPath(new URL(`./${helper}.ts`, import.meta.url));
      return null;
    },
    load(id) {
      if (moduleId(id) !== `${moduleId(desktop)}/src/ui/PreviewKit.tsx`)
        return null;
      return readFileSync(
        new URL('./views/PreviewKit.tsx.preview', import.meta.url),
        'utf8',
      );
    },
    transform(source, id) {
      return transformBrand(source, id, desktop);
    },
  };
}
export function isolatePreviewBuild(config: InlineConfig): InlineConfig {
  return { ...config, configFile: false, envDir: false, envPrefix: [] };
}
