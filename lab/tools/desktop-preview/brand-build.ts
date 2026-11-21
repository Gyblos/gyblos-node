// Applies the public brand and composer-copy proposals only to browser bundles, with portable IDs.
// Shipped desktop sources and operational configuration are never changed.

import { readFileSync } from 'node:fs';

import type { InlineConfig, Plugin } from 'vite';

import brand from './brand.json' with { type: 'json' };

export { brand };
const moduleId = (value: string) => value.replaceAll('\\', '/');
function replaceOnce(source: string, before: string, after: string) {
  if (
    !source.includes(before) ||
    source.indexOf(before) !== source.lastIndexOf(before)
  )
    throw new Error(
      'Desktop brand review hook changed; update the preview explicitly.',
    );
  return source.replace(before, after);
}
// Applies each replacement in order, each exactly once (replaceOnce).
const replaceEach = (source: string, pairs: readonly [string, string][]) =>
  pairs.reduce(
    (text, [before, after]) => replaceOnce(text, before, after),
    source,
  );
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
      facts,
      '      <div>\n        <dt>Network</dt>\n        <dd>Solana</dd>\n      </div>\n',
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
      "  compact?: boolean;\n  size?: 'lg';",
    );
    return replaceOnce(
      typed,
      '      ref={ref}',
      '      data-size={size}\n      ref={ref}',
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
      "import { ChartBar, type Icon } from '@phosphor-icons/react';\n" +
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
  if (target === `${base}/src/ui/Models.tsx`)
    return replaceOnce(
      source,
      'const [network, setNetwork] = useState(false)',
      "const [network, setNetwork] = useState(() => new URLSearchParams(location.search).get('review') === 'network')",
    );
  if (target === `${base}/src/desktop-app.tsx`)
    return replaceOnce(
      replaceOnce(source, '<Payments\n', '<Payments chat={chatController}\n'),
      'const [light, setLight] = useState(prefersLightTheme)',
      "const [light, setLight] = useState(() => new URLSearchParams(location.search).get('theme') === 'light')",
    );
  if (target === `${base}/src/ui/WindowTitlebar.tsx`)
    return replaceOnce(
      source,
      '{props.children}',
      '<span className="preview-environment">Beta · Devnet</span>{props.children}',
    );
  if (target === `${base}/src/ui/BuyerAgentSetup.tsx`)
    return replaceEach(source, [
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
    ]);
  if (target === `${base}/src/x402-model.ts`)
    return replaceEach(source, [
      ["'USDC · devnet'", "'USDC'"],
      ['Only Solana devnet is supported', 'Unsupported payment network'],
      [
        "String(BigInt(atomic) % scale).padStart(DESKTOP_X402.ATOMIC_DECIMALS, '0')\n  );",
        "String(BigInt(atomic) % scale).padStart(DESKTOP_X402.ATOMIC_DECIMALS, '0')\n  ).replace(/0+$/, '').replace(/\\.$/, '');",
      ],
    ]);
  if (target === `${base}/src/ui/Chat.tsx`)
    return replaceEach(source, [
      ["'x402 · devnet'", "'x402'"],
      ["'Free · Gyblos network'", "''"],
    ]);
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
}
export function reviewBrand(desktop: string): Plugin {
  return {
    name: 'desktop-brand-review',
    enforce: 'pre',
    transform(source, id) {
      return transformBrand(source, id, desktop);
    },
  };
}
export function isolatePreviewBuild(config: InlineConfig): InlineConfig {
  return { ...config, configFile: false, envDir: false, envPrefix: [] };
}
