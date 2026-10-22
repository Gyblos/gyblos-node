// Owns architectural policy and current-to-future package mapping.
// Static analysis only: this module must never load product modules or secrets.
export const SOURCE_ROOTS = [
  'apps',
  'packages',
  'scripts',
  'lab',
  'tooling',
  'tests',
];
export const PRIVATE_PATH =
  '(^|/)(?:\\.local|\\.git|dist|coverage|evidence|captures)(?:/|$)|(^|/)\\.env(?:\\.|$)|\\.(?:key|pem|log)$';
export const LAB_PATH =
  '^(?:lab/|scripts/|packages/gate/|tooling/(?:lab-[^/]+|nat-regression|native-nat-probe|public-path-(?:audit|counters)|udp-probe|iroh-probe)\\.mjs$)';
const ADAPTER_NAME =
  /^(?:inference-ollama|transport|payments-x402|identity|engine-.+|transport-.+|discovery-.+)$/;
const PACKAGE_PATH = '^packages/';
const CORE_PATH = '^packages/(?:application|core)/';
const PROTOCOL_PATH = '^packages/protocol/';
const PRODUCT_PATH = '^(?:packages/|apps/)';
const SDK_PATH = '(^|/)(?:@solana(?:-program)?/|@x402/|@number0/iroh(?:/|$))';

export function layerOf(source) {
  if (new RegExp(LAB_PATH).test(source)) return 'lab';
  if (source.startsWith('tests/') || source.startsWith('tooling/'))
    return 'verification';
  if (source.startsWith('apps/')) return 'apps';
  const name = source.match(/^packages\/([^/]+)\//)?.[1];
  if (name === 'application' || name === 'core') return 'core';
  if (ADAPTER_NAME.test(name ?? '')) return 'adapter';
  if (['protocol', 'config', 'runtime', 'node'].includes(name)) return name;
  return null;
}

function rule(name, from, to) {
  return { name, severity: 'warn', from, to };
}

export function boundaryConfig(packageNames, appNames) {
  const adapters = packageNames.filter((name) => ADAPTER_NAME.test(name));
  const adapterPath = `^packages/(?:${adapters.join('|')})/`;
  const higherThanCore = `(?:${adapterPath}|^packages/node/|^apps/)`;
  return {
    forbidden: [
      rule(
        'protocol-is-independent',
        { path: PROTOCOL_PATH },
        {
          path: '^(?:packages/(?!protocol/)|apps/|scripts/|lab/|tooling/)',
        },
      ),
      rule(
        'protocol-has-no-sdk',
        { path: PROTOCOL_PATH },
        {
          dependencyTypes: [
            'npm',
            'npm-dev',
            'npm-optional',
            'npm-peer',
            'npm-no-pkg',
            'npm-unknown',
          ],
        },
      ),
      rule(
        'core-does-not-import-higher-layers',
        { path: CORE_PATH },
        { path: higherThanCore },
      ),
      rule('domain-has-no-sdk', { path: CORE_PATH }, { path: SDK_PATH }),
      rule(
        'domain-has-no-filesystem',
        { path: '^packages/(?:protocol|application|core)/' },
        {
          path: '^(?:node:)?fs(?:/|$)',
        },
      ),
      rule(
        'config-is-a-leaf',
        { path: '^packages/config/' },
        {
          path: '^(?:packages/(?!config/)|apps/|scripts/|lab/|tooling/)',
        },
      ),
      rule(
        'runtime-only-uses-config',
        { path: '^packages/runtime/' },
        {
          path: '^(?:packages/(?!(?:config|runtime)/)|apps/|scripts/|lab/|tooling/)',
        },
      ),
      rule(
        'adapters-do-not-import-composition',
        { path: adapterPath },
        { path: '^(?:packages/node/|apps/)' },
      ),
      rule(
        'node-does-not-import-apps',
        { path: '^packages/node/' },
        { path: '^apps/' },
      ),
      rule(
        'product-does-not-import-lab',
        { path: PRODUCT_PATH, pathNot: '^packages/gate/' },
        { path: LAB_PATH },
      ),
      rule(
        'product-does-not-import-verification',
        { path: PRODUCT_PATH, pathNot: '^packages/gate/' },
        {
          path: '^(?:tests/|tooling/)',
          pathNot: LAB_PATH,
        },
      ),
      ...adapters.map((name) =>
        rule(
          `adapter-${name}-is-independent`,
          {
            path: `${PACKAGE_PATH}${name}/`,
          },
          { path: adapterPath, pathNot: `${PACKAGE_PATH}${name}/` },
        ),
      ),
      ...appNames.map((name) =>
        rule(
          `app-${name}-is-independent`,
          {
            path: `^apps/${name}/`,
          },
          { path: '^apps/', pathNot: `^apps/${name}/` },
        ),
      ),
    ],
    options: {
      tsPreCompilationDeps: true,
      tsConfig: { fileName: 'tsconfig.json' },
      doNotFollow: { path: '(^|/)node_modules/' },
      // analyze() restricts traversal to its vetted source inventory. Keep
      // other edges visible so excluded/private source imports fail closed.
      enhancedResolveOptions: {
        exportsFields: ['exports'],
        conditionNames: ['import', 'node', 'default', 'types'],
      },
    },
  };
}
