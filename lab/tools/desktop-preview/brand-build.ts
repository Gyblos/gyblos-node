// Applies the public brand and composer-copy proposals only to browser bundles, with portable IDs.
// Shipped desktop sources and operational configuration are never changed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { InlineConfig, Plugin } from 'vite';

import { transformCodeSamples } from './brand-code';
import { replaceEach, replaceOnce } from './brand-replace';
import brand from './brand.json' with { type: 'json' };
import * as funds from './funds-build';

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
  ]) {
    if (target === `${base}/src/ui/${component}.tsx`)
      return readFileSync(
        new URL(`./views/${component}.tsx.preview`, import.meta.url),
        'utf8',
      );
  }
  if (target === `${base}/src/ui/WalletDetails.tsx`) {
    const recovery = replaceOnce(
      source,
      '<List label="Wallet recovery">\n        <ListRow\n          leading={null}',
      `<List label="Wallet recovery">
        <ListRow
          leading={ready && wallet.backupVerified
            ? <CheckCircle size={20} weight="fill" className="backup-verified-icon" aria-hidden="true" />
            : ready
              ? <Warning size={20} weight="fill" className="backup-needed-icon" aria-hidden="true" />
              : null}`,
    );
    const facts = replaceEach(recovery, [
      ['import { Archive,', 'import { CheckCircle, Warning, Archive,'],
      [
        'Create a recovery file and verify it.',
        'No verified backup yet. Back up this wallet to recover it later.',
      ],
      ['<dt>Solana address</dt>', '<dt>Wallet address</dt>'],
    ]);
    return replaceOnce(
      replaceOnce(
        replaceOnce(
          facts,
          '      <div>\n        <dt>Network</dt>\n        <dd>Solana</dd>\n      </div>\n',
          '',
        ),
        '      <div>\n        <dt>Private key</dt>\n        <dd>Protected on this device</dd>\n      </div>\n',
        '',
      ),
      '        <strong>On this device</strong>\n',
      '',
    );
  }
  if (target === `${base}/src/ui/Modal.tsx`) {
    const props = replaceOnce(
      source,
      '  compact = false,',
      '  compact = false,\n  size,',
    );
    const typed = replaceOnce(
      props,
      '  compact?: boolean;',
      "  compact?: boolean;\n  size?: 'sm' | 'md' | 'lg';",
    );
    const restoring = replaceOnce(
      typed,
      '  const dismissal = useRef(createModalDismissal());',
      '  const dismissal = useRef(createModalDismissal());\n  useEffect(() => {\n    const opener = document.activeElement;\n    return () => {\n      if (opener instanceof HTMLElement && opener.isConnected)\n        requestAnimationFrame(() => opener.focus());\n    };\n  }, []);',
    );
    return replaceOnce(
      restoring,
      '      ref={ref}',
      "      data-size={compact ? undefined : (size ?? 'md')}\n      ref={ref}",
    );
  }
  if (target === `${base}/src/ui/UI.tsx`) {
    const start = source.indexOf('export function StatCard(');
    const end = source.indexOf('export function EmptyState(', start);
    if (start < 0 || end < start)
      throw new Error('Missing StatCard preview hook');
    const card = readFileSync(
      new URL('./views/StatCard.tsx.preview', import.meta.url),
      'utf8',
    );
    return (
      "import { ChartBar, Question, type Icon } from '@phosphor-icons/react';\n" +
      source.slice(0, start) +
      card +
      source.slice(end)
    );
  }
  if (target === `${base}/src/ui/PaypalSessionPanel.tsx`) {
    return (
      "import { usageChange } from '../../../../lab/tools/desktop-preview/usage';\ndeclare global { interface Window { previewPaypalBaseline: ReturnType<typeof paypalPaymentSummary> } }\n" +
      "import { Gauge, Receipt, Wallet } from '@phosphor-icons/react';\n" +
      replaceEach(source, [
        [
          "import { Facts, Pair } from './Management';",
          "import { StatCard, StatGrid } from './UI';",
        ],
        ['<Facts>', '<StatGrid>'],
        ['</Facts>', '</StatGrid>'],
        [
          '<Pair label="Session limit"',
          '<StatCard icon={Gauge} change={usageChange(summary.limitCents, window.previewPaypalBaseline.limitCents)} comparison="Since the preview opened" label="Session limit"',
        ],
        [
          '<Pair\n',
          '<StatCard icon={Receipt} comparison="Since the preview opened" change={summary.capturedCents !== null ? usageChange(summary.capturedCents, window.previewPaypalBaseline.capturedCents) : usageChange(summary.usedCents, window.previewPaypalBaseline.usedCents)}\n',
        ],
        [
          '<Pair label="Remaining"',
          '<StatCard icon={Wallet} change={usageChange(summary.remainingCents, window.previewPaypalBaseline.remainingCents)} comparison="Since the preview opened" label="Remaining"',
        ],
      ])
    );
  }
  if (target === `${base}/src/ui/SystemStatus.tsx`)
    return replaceOnce(
      source,
      'useState(false)',
      "useState(() => new URLSearchParams(location.search).get('review') === 'system-status')",
    );
  if (target === `${base}/src/ui/NetworkStatus.tsx`)
    return replaceEach(source, [
      [
        '<span className="network-status-dot" />',
        `<span className="network-status-dot" />
      <svg className="preview-node-hex network-glyph" viewBox="0 0 144 128" aria-hidden="true">
        {[0,1,2,3,4,5].map(i => (
          <g key={i} transform={'rotate(' + i*60 + ' 72 64)'} style={{animationDelay: (i * .38) + 's'}}>
            <path className="hex-trace" d="M72 52 V12 L117.03 38" />
            {['trail','head'].map(part => <path key={part} className={'hex-current hex-' + part} pathLength="100" d="M72 52 V12 L117.03 38" />)}
            <circle className="hex-halo" cx="72" cy="12" r="7" />
            <circle className="hex-terminal" cx="72" cy="12" r="4" />
          </g>
        ))}
        <path fill="currentColor" transform="translate(58.6 72.7) scale(.045 -.045)" d="M297 -162Q234 -162 186.5 -143Q139 -124 108 -89Q77 -54 66 -8L190 0Q199 -29 224 -45.5Q249 -62 297 -62Q359 -62 391.5 -35Q424 -8 424 44L424 114Q405 75 366.5 51.5Q328 28 273 28Q208 28 157 60.5Q106 93 77 151Q48 209 48 284Q48 363 76.5 421.5Q105 480 155 513Q205 546 270 546Q325 546 365.5 521Q406 496 426 452L428 534L542 534L542 55Q542 -16 512 -64.5Q482 -113 427 -137.5Q372 -162 297 -162ZM297 127Q353 127 388 168Q423 209 424 286Q424 337 408.5 373Q393 409 364 427.5Q335 446 297 446Q237 446 204 404.5Q171 363 171 286Q171 209 204.5 168Q238 127 297 127Z" />
      </svg>`,
      ],
      [
        '    </button>',
        '      {retry && <span className="preview-node-retry">Retry</span>}\n    </button>',
      ],
    ]);
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
  if (target === `${base}/src/ui/Models.tsx`) {
    const models = replaceOnce(
      source,
      'const [network, setNetwork] = useState(false)',
      "const [network, setNetwork] = useState(() => new URLSearchParams(location.search).get('review') === 'network')",
    );
    const row = models.indexOf('function ModelRow(');
    if (row < 0) throw new Error('Missing model row review hook');
    return (
      "import { CaretRight, Check } from '@phosphor-icons/react';\nimport { usdPerMtok } from './model-price';\nimport { Savings } from './PreviewKit';\nimport { BUTTON_VARIANT } from './constants';\n" +
      models.slice(0, row) +
      readFileSync(
        new URL('./views/ModelRow.tsx.preview', import.meta.url),
        'utf8',
      )
    );
  }
  if (target === `${base}/src/desktop-app.tsx`) {
    const routed = replaceOnce(
      replaceOnce(
        replaceOnce(
          source,
          '<Payments\n',
          "<Payments key={view} chat={chatController} initialTab={view === UI_VIEW.ACTIVITY ? 'activity' : undefined} selectedSession={activitySession}\n",
        ),
        '{view === UI_VIEW.PAYMENTS && (',
        '{(view === UI_VIEW.PAYMENTS || view === UI_VIEW.ACTIVITY) && (',
      ),
      '{view === UI_VIEW.ACTIVITY && (\n            <Activity',
      '{false && (\n            <Activity',
    );
    const funded = replaceEach(routed, [...funds.APP_FUNDS_REWRITES]);
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
  if (target === `${base}/src/ui/constants.ts`)
    return replaceOnce(
      replaceOnce(
        source,
        "{ name: UI_VIEW.ACTIVITY, label: 'Activity' }",
        "{ name: UI_VIEW.ACTIVITY, label: 'Usage & payments' }",
      ),
      "{ name: UI_VIEW.PAYMENTS, label: 'Payments' }",
      "{ name: UI_VIEW.PAYMENTS, label: 'Usage & payments' }",
    );
  if (target === `${base}/src/ui/BuyerSidebar.tsx`) {
    const start = source.indexOf('export function BuyerSidebar(');
    if (start < 0) throw new Error('Missing sidebar review hook');
    return (
      source.slice(0, start) +
      readFileSync(
        new URL('./views/BuyerSidebar.tsx.preview', import.meta.url),
        'utf8',
      )
    );
  }
  if (target === `${base}/src/ui/WindowTitlebar.tsx`)
    return replaceOnce(
      replaceOnce(
        "import { useState as usePreviewState } from 'react';\nimport { PREVIEW_EVENT } from './PreviewKit';\n" +
          source +
          readFileSync(
            new URL('./views/NetworkSwitch.tsx.preview', import.meta.url),
            'utf8',
          ),
        '{props.children}',
        '<PreviewNetwork />{props.children}',
      ),
      'data-platform={platform}',
      "data-platform={platform}\n      data-fullscreen={new URLSearchParams(location.search).get('fullscreen') === '1' || undefined}",
    );
  if (target === `${base}/src/ui/BuyerAgentSetup.tsx`)
    return (
      "import { agentCodeLanguage, CodeBlock } from './PreviewKit';\n" +
      replaceEach(source, [
        [
          '      <pre className="ui-code-block" aria-label="Generated agent configuration">\n        {preview.text}\n      </pre>',
          '      <CodeBlock language={agentCodeLanguage(preview.tool)} title="Generated agent configuration" code={preview.text} />',
        ],
        [
          '<Button disabled={disabled} onClick',
          '<Button variant={BUTTON_VARIANT.PRIMARY} disabled={disabled} onClick',
        ],
        ['Connect agent', 'Connect a tool'],
        ['Connect an agent', 'Connect a tool'],
        ['label="Agent"', 'label="Tool"'],
        [
          'Uses the models served by your local buyer.',
          'Supports OpenAI Chat Completions, Responses and Anthropic Messages through your local buyer.',
        ],
      ])
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
  if (target === `${base}/src/ui/Dropdown.tsx`)
    return replaceEach(source, [...funds.MENU_REWRITES]);
  if (target === `${base}/src/ui/BuyerFunding.tsx`)
    return source.replaceAll(
      'Could not open the devnet faucet.',
      'Could not open the testnet faucet.',
    );
  if (target === `${base}/src/ui/ChatAnswer.tsx`)
    return (
      "import { PreviewAnswerSkeleton } from './PreviewKit';\n" +
      replaceOnce(
        source,
        '        </AssistantProgress>\n      )}\n',
        '        </AssistantProgress>\n      )}\n      {message.state === MESSAGE_STATE.PENDING && !message.text && <PreviewAnswerSkeleton />}\n',
      )
    );
  if (target === `${base}/src/ui/Chat.tsx`)
    return (
      "import { PreviewConnectEntry } from './PreviewKit';\n" +
      replaceEach(source, [
        [
          '<p>Choose how to pay. Keep the conversation.</p>',
          '<p>Choose how to pay. Keep the conversation.</p>\n              <PreviewConnectEntry />',
        ],
        ["'x402 · devnet'", "'x402'"],
        ["'Free · Gyblos network'", "''"],
        ...funds.CHAT_FUNDS_REWRITES,
      ])
    );
  if (target === `${base}/src/theme.ts`) {
    for (const [name, value] of Object.entries(brand.themeTokens)) {
      const pattern = new RegExp(`  ${name}: '[^']+',`);
      if (!pattern.test(source)) throw new Error('Missing desktop brand token');
      source = source.replace(pattern, `  ${name}: '${value}',`);
    }
    source = replaceOnce(
      source,
      "'--blue': light\n      ? colors.blue\n      : 'color-mix(in srgb, var(--accent), white 35%)',",
      "'--blue': light ? colors.inkLight : colors.inkDark,",
    );
    return replaceOnce(
      source,
      "'--focus': light\n      ? colors.blue\n      : 'color-mix(in srgb, var(--accent), white 12%)',",
      "'--focus': light ? colors.inkLight : colors.inkDark,",
    );
  }
  if (target === `${base}/src/ui/Signal.tsx`) {
    const start = source.indexOf('export function SignalMark(');
    const end = source.indexOf('export function SignalTrace(');
    if (start < 0 || end <= start)
      throw new Error('Missing desktop mark review hook');
    const mark = `export function SignalMark() { return createElement('span', {className:'preview-brand-mark','aria-hidden':true}, createElement('img',{className:'preview-brand-dark',src:'./gyblos-mark-solid-dark.svg',alt:''}),createElement('img',{className:'preview-brand-light',src:'./gyblos-mark-solid-light.svg',alt:''})); }\n`;
    return (
      "import { createElement } from 'react';\n" +
      source.slice(0, start) +
      mark +
      source.slice(end)
    );
  }
}
export function reviewBrand(desktop: string): Plugin {
  return {
    name: 'desktop-brand-review',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        source === './PreviewKit' &&
        importer !== undefined &&
        moduleId(importer).startsWith(`${moduleId(desktop)}/src/ui/`)
      )
        return `${desktop}/src/ui/PreviewKit.tsx`;
      if (
        source === './code-highlight' &&
        importer !== undefined &&
        moduleId(importer) === `${moduleId(desktop)}/src/ui/PreviewKit.tsx`
      )
        return fileURLToPath(new URL('./code-highlight.ts', import.meta.url));
      if (
        source === './status-tone' &&
        importer !== undefined &&
        moduleId(importer) === `${moduleId(desktop)}/src/ui/PreviewKit.tsx`
      )
        return fileURLToPath(new URL('./status-tone.ts', import.meta.url));
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
