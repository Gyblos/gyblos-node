// Owns the review inventory projection; it excludes private state and agent-control files.
import { REVIEW_VALUES, REVIEWABLE_FILE_PATTERN } from './constants';
import type { ReviewUnit } from './types';

const INVALID_PATH = /[\x00-\x1f\x7f\\]/;

interface CrossCuttingDefinition {
  id: string;
  label: string;
  prefixes: string[];
  exactPaths: string[];
}

const CROSS_CUTTING_DEFINITIONS: CrossCuttingDefinition[] = [
  {
    id: 'flow-protocol',
    label: 'Protocol and execution flow',
    prefixes: [
      'packages/protocol/',
      'packages/core/',
      'packages/node/',
      'packages/buyer/',
      'apps/buyer/',
      'apps/node/',
    ],
    exactPaths: [],
  },
  {
    id: 'flow-payments',
    label: 'Payment and economic flow',
    prefixes: [
      'packages/payments-',
      'packages/x402-',
      'packages/protocol/',
      'packages/core/',
      'packages/node/',
      'packages/inference/',
      'packages/buyer/',
      'apps/buyer/',
      'apps/node/',
    ],
    exactPaths: ['package.json'],
  },
  {
    id: 'flow-p2p-identity',
    label: 'P2P transport, identity and discovery flow',
    prefixes: [
      'packages/transport-',
      'packages/identity/',
      'packages/discovery-',
      'packages/node/',
      'packages/buyer/',
      'apps/buyer/',
      'apps/discovery-index/',
    ],
    exactPaths: [],
  },
  {
    id: 'flow-desktop-local',
    label: 'Desktop and local-node boundary',
    prefixes: [
      'apps/desktop/',
      'packages/config/',
      'packages/runtime/',
      'packages/node/',
    ],
    exactPaths: [],
  },
  {
    id: 'flow-supply-chain',
    label: 'CI, dependencies and release supply chain',
    prefixes: ['.github/', 'tooling/'],
    exactPaths: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  },
];

export function reviewableFiles(files: string[]): string[] {
  return [...new Set(files)]
    .filter((file) => file.length > 0)
    .filter((file) => !REVIEWABLE_FILE_PATTERN.test(file))
    .filter((file) => !INVALID_PATH.test(file))
    .filter((file) => !file.startsWith('/'))
    .filter((file) => !file.split('/').includes('..'))
    .filter((file) => !file.split('/').includes('.'))
    .sort();
}

function topLevelUnit(file: string): ReviewUnit | undefined {
  const app = file.match(/^apps\/([^/]+)\//)?.[1];
  if (app) {
    return {
      id: `app-${app}`,
      label: `Application: ${app}`,
      kind: REVIEW_VALUES.APP,
      paths: [],
    };
  }

  const packageName = file.match(/^packages\/([^/]+)\//)?.[1];
  if (packageName) {
    return {
      id: `package-${packageName}`,
      label: `Package: ${packageName}`,
      kind: REVIEW_VALUES.PACKAGE,
      paths: [],
    };
  }

  return undefined;
}

function isSupplyChainPath(file: string): boolean {
  return (
    file.startsWith('.github/') ||
    file.startsWith('tooling/') ||
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file)
  );
}

function addPath(unit: ReviewUnit, file: string): void {
  if (!unit.paths.includes(file)) unit.paths.push(file);
}

function unitFromDefinition(
  definition: CrossCuttingDefinition,
  files: string[],
): ReviewUnit | undefined {
  const paths = files.filter(
    (file) =>
      definition.exactPaths.includes(file) ||
      definition.prefixes.some((prefix) => file.startsWith(prefix)),
  );
  if (paths.length === 0) return undefined;
  return {
    id: definition.id,
    label: definition.label,
    kind: REVIEW_VALUES.CROSS_CUTTING,
    paths,
  };
}

export function buildReviewUnits(files: string[]): ReviewUnit[] {
  const inventory = reviewableFiles(files);
  const topLevel = new Map<string, ReviewUnit>();

  for (const file of inventory) {
    const unit = topLevelUnit(file);
    if (unit) {
      const existing = topLevel.get(unit.id);
      if (existing) addPath(existing, file);
      else {
        addPath(unit, file);
        topLevel.set(unit.id, unit);
      }
    }
  }

  const repositoryPaths = inventory.filter(isSupplyChainPath);
  if (repositoryPaths.length > 0) {
    topLevel.set('repository-supply-chain', {
      id: 'repository-supply-chain',
      label: 'Repository supply chain',
      kind: REVIEW_VALUES.REPOSITORY,
      paths: repositoryPaths,
    });
  }

  const otherPaths = inventory.filter(
    (file) => !topLevelUnit(file) && !isSupplyChainPath(file),
  );
  if (otherPaths.length > 0)
    topLevel.set('repository-other', {
      id: 'repository-other',
      label: 'Rules, tests, documentation and deployment',
      kind: REVIEW_VALUES.REPOSITORY,
      paths: otherPaths,
    });

  const crossCutting = CROSS_CUTTING_DEFINITIONS.map((definition) =>
    unitFromDefinition(definition, inventory),
  ).filter((unit): unit is ReviewUnit => unit !== undefined);

  return [...topLevel.values(), ...crossCutting]
    .map((unit) => ({ ...unit, paths: [...new Set(unit.paths)].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function changedPathMatchesUnit(
  unit: ReviewUnit,
  changedFile: string,
): boolean {
  return unit.paths.some(
    (path) =>
      path === changedFile ||
      path.startsWith(`${changedFile}/`) ||
      changedFile.startsWith(`${path}/`),
  );
}
