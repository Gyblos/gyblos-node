// Owns architectural policy and current-to-future package mapping.
// Static analysis only: this module must never load product modules or secrets.
import type {
  ICruiseOptions,
  IRegularForbiddenRuleType,
} from 'dependency-cruiser';

export const SOURCE_ROOTS = ['apps', 'packages', 'lab', 'tooling', 'tests'];
export const PRIVATE_PATH =
  '(^|/)(?:\\.local|\\.git|dist|coverage|evidence|captures)(?:/|$)|(^|/)\\.env(?:\\.|$)|\\.(?:key|pem|log)$';
export const LAB_PATH = '^lab/';
const ADAPTER_NAME =
  /^(?:payments-.+|identity|engine-.+|transport-.+|discovery-.+|telemetry-.+)$/;
// Packages meant to leave the monorepo: they import no workspace code and only
// payment adapters (and verification) may import them.
const STANDALONE_NAMES = ['x402-upto-metered'];
const PAYMENT_ADAPTER = 'payments-[^/]+';
const PACKAGE_PATH = '^packages/';
const CORE_PATH = '^packages/core/';
const PROTOCOL_PATH = '^packages/protocol/';
const PRODUCT_PATH = '^(?:packages/|apps/)';
const SDK_PATH =
  '(^|/)(?:@solana(?:-program)?/|@x402/|@number0/iroh(?:/|$)|@huggingface/tokenizers(?:/|$))';

export const BOUNDARY_LAYERS = {
  PROTOCOL: 'protocol',
  CORE: 'core',
  ADAPTER: 'adapter',
  NODE: 'node',
  CONFIG: 'config',
  RUNTIME: 'runtime',
  APPS: 'apps',
  LAB: 'lab',
  VERIFICATION: 'verification',
  STANDALONE: 'standalone',
} as const;

export type BoundaryLayer =
  (typeof BOUNDARY_LAYERS)[keyof typeof BOUNDARY_LAYERS];
export interface BoundaryConfig {
  forbidden: IRegularForbiddenRuleType[];
  options: ICruiseOptions;
}

export function layerOf(source: string): BoundaryLayer | null {
  if (new RegExp(LAB_PATH).test(source)) return BOUNDARY_LAYERS.LAB;
  if (source.startsWith('tests/') || source.startsWith('tooling/'))
    return BOUNDARY_LAYERS.VERIFICATION;
  if (source.startsWith('apps/')) return BOUNDARY_LAYERS.APPS;
  const name = source.match(/^packages\/([^/]+)\//)?.[1];
  if (name === BOUNDARY_LAYERS.CORE) return BOUNDARY_LAYERS.CORE;
  if (STANDALONE_NAMES.includes(name ?? '')) return BOUNDARY_LAYERS.STANDALONE;
  if (ADAPTER_NAME.test(name ?? '')) return BOUNDARY_LAYERS.ADAPTER;
  if (
    name === BOUNDARY_LAYERS.PROTOCOL ||
    name === BOUNDARY_LAYERS.CONFIG ||
    name === BOUNDARY_LAYERS.RUNTIME ||
    name === BOUNDARY_LAYERS.NODE
  )
    return name;
  return null;
}

function standaloneRules(name: string): IRegularForbiddenRuleType[] {
  const own = `${PACKAGE_PATH}${name}/`;
  return [
    rule(
      `standalone-${name}-is-independent`,
      { path: own },
      {
        path: `^(?:packages/(?!${name}/)|apps/|lab/|tooling/|tests/)`,
      },
    ),
    rule(
      `standalone-${name}-is-only-used-by-payments`,
      {
        path: `^(?:packages/(?!(?:${PAYMENT_ADAPTER}|${name})/)|apps/|lab/)`,
      },
      { path: own },
    ),
  ];
}

function rule(
  name: string,
  from: IRegularForbiddenRuleType['from'],
  to: IRegularForbiddenRuleType['to'],
): IRegularForbiddenRuleType {
  return { name, severity: 'warn', from, to };
}

export function boundaryConfig(
  packageNames: string[],
  appNames: string[],
): BoundaryConfig {
  const adapters = packageNames.filter((name) => ADAPTER_NAME.test(name));
  const adapterPath = `^packages/(?:${adapters.join('|')})/`;
  const higherThanCore = `(?:${adapterPath}|^packages/node/|^apps/)`;
  return {
    forbidden: [
      rule(
        'protocol-is-independent',
        { path: PROTOCOL_PATH },
        {
          path: '^(?:packages/(?!protocol/)|apps/|lab/|tooling/)',
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
        { path: '^packages/(?:protocol|core)/' },
        {
          path: '^(?:node:)?fs(?:/|$)',
        },
      ),
      rule(
        'config-is-a-leaf',
        { path: '^packages/config/' },
        {
          path: '^(?:packages/(?!config/)|apps/|lab/|tooling/)',
        },
      ),
      rule(
        'runtime-only-uses-config',
        { path: '^packages/runtime/' },
        {
          path: '^(?:packages/(?!(?:config|runtime)/)|apps/|lab/|tooling/)',
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
        { path: PRODUCT_PATH },
        { path: LAB_PATH },
      ),
      rule(
        'product-does-not-import-verification',
        { path: PRODUCT_PATH },
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
      ...packageNames
        .filter((name) => STANDALONE_NAMES.includes(name))
        .flatMap(standaloneRules),
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
