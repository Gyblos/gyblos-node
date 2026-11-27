// Builds the Gyblos component registry (registry.json) into public/r: one shadcn registry item per
// component, with each file's source inlined, so any Gyblos app can install it with
// `npx shadcn add https://explorer.gyblos.com/r/<name>.json`. Files install at their own path (`target`), so
// their relative imports hold; a dependency on another item of this registry becomes its URL.
// Generated output, not committed (public/r is ignored).
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ITEM_SCHEMA = 'https://ui.shadcn.com/schema/registry-item.json';
const output = resolve(root, 'public/r');

interface RegistryFile {
  path: string;
  type: string;
  target?: string;
}
interface RegistryItem {
  name: string;
  files?: RegistryFile[];
  cssVars?: unknown;
  registryDependencies?: string[];
  [key: string]: unknown;
}
interface Registry {
  homepage: string;
  items: RegistryItem[];
  [key: string]: unknown;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PATH_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isRelativeFilePath(value: string): boolean {
  return value.split('/').every((segment) => PATH_SEGMENT.test(segment));
}

function isRegistryFile(value: unknown): value is RegistryFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    isRelativeFilePath(value.path) &&
    'type' in value &&
    typeof value.type === 'string' &&
    (!('target' in value) ||
      (typeof value.target === 'string' && isRelativeFilePath(value.target)))
  );
}

function isRegistryItem(value: unknown): value is RegistryItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    NAME_PATTERN.test(value.name) &&
    (!('files' in value) ||
      (Array.isArray(value.files) && value.files.every(isRegistryFile))) &&
    (!('registryDependencies' in value) ||
      (Array.isArray(value.registryDependencies) &&
        value.registryDependencies.every(
          (name: unknown) => typeof name === 'string',
        )))
  );
}

function isRegistry(value: unknown): value is Registry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'homepage' in value &&
    typeof value.homepage === 'string' &&
    'items' in value &&
    Array.isArray(value.items) &&
    value.items.every(isRegistryItem)
  );
}

async function boardTheme() {
  const theme: Record<string, string> = {};
  for (const sheet of ['tokens', 'typography']) {
    const source = await readFile(
      resolve(root, 'boardui/styles', sheet + '.css'),
      'utf8',
    );
    postcss.parse(source).walkAtRules('theme', (rule) => {
      rule.walkDecls((decl) => {
        theme[decl.prop.slice(2)] = decl.value;
      });
    });
  }
  return {
    theme,
    light: { 'boardui-inner': 'var(--bg)' },
    dark: { 'boardui-inner': 'var(--raised)' },
  };
}

const parsed: unknown = JSON.parse(
  await readFile(resolve(root, 'registry.json'), 'utf8'),
);
if (!isRegistry(parsed)) throw new Error('registry.json is not a registry');
const registry = parsed;
const origin = registry.homepage;
const names = new Set(registry.items.map((item) => item.name));
const url = (name: string) =>
  names.has(name) ? `${origin}/r/${name}.json` : name;

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const item of registry.items) {
  const files = await Promise.all(
    (item.files ?? []).map(async (file) => ({
      path: file.path,
      type: file.type,
      target: file.target,
      content: await readFile(resolve(root, file.path), 'utf8'),
    })),
  );
  const built = {
    $schema: ITEM_SCHEMA,
    ...item,
    ...(item.name === 'board-base' ? { cssVars: await boardTheme() } : {}),
    ...(item.registryDependencies
      ? { registryDependencies: item.registryDependencies.map(url) }
      : {}),
    ...(files.length ? { files } : {}),
  };
  await writeFile(
    resolve(output, `${item.name}.json`),
    `${JSON.stringify(built, null, 2)}\n`,
  );
}
const index = {
  ...registry,
  items: registry.items.map(({ files, cssVars, ...item }) => ({
    ...item,
    ...(files
      ? { files: files.map(({ path, type }) => ({ path, type })) }
      : {}),
  })),
};
await writeFile(
  resolve(output, 'registry.json'),
  `${JSON.stringify(index, null, 2)}\n`,
);
console.log(`registry: ${registry.items.length} items in public/r`);
