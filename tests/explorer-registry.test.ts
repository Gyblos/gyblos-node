// Protects the explorer's component registry (apps/explorer/registry.json, built into public/r): every
// board component is published, every listed file exists and installs at its own path, every
// dependency on another item names an item of this registry, and npm dependencies are pinned.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../apps/explorer');
const BOARD = 'components/board';
interface Item {
  name: string;
  type: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files?: { path: string; type: string; target: string }[];
  cssVars?: Record<string, Record<string, string>>;
}
const registry = JSON.parse(
  readFileSync(resolve(ROOT, 'registry.json'), 'utf8'),
) as { homepage: string; items: Item[] };

void test('every board component and file is published and exists', () => {
  const listed = new Set(
    registry.items.flatMap((item) => item.files ?? []).map((file) => file.path),
  );
  for (const file of readdirSync(resolve(ROOT, BOARD)))
    assert.ok(listed.has(`${BOARD}/${file}`), `${file} is not in the registry`);
  for (const path of listed) assert.ok(existsSync(resolve(ROOT, path)), path);
  for (const file of registry.items.flatMap((item) => item.files ?? []))
    assert.equal(file.target, file.path);
});

void test('item dependencies are items of this registry and npm dependencies are pinned', () => {
  const names = new Set(registry.items.map((item) => item.name));
  assert.equal(names.size, registry.items.length);
  for (const item of registry.items) {
    for (const dependency of item.registryDependencies ?? [])
      assert.ok(names.has(dependency), `${item.name} → ${dependency}`);
    for (const dependency of item.dependencies ?? [])
      assert.match(dependency, /^(@[^/]+\/)?[^@]+@\d+\.\d+\.\d+$/);
  }
  assert.equal(registry.homepage, 'https://explorer.gyblos.com');
});

void test('the explorer pins the same versions it publishes', () => {
  const pkg = JSON.parse(
    readFileSync(resolve(ROOT, 'package.json'), 'utf8'),
  ) as {
    dependencies: Record<string, string>;
  };
  for (const dependency of registry.items.flatMap(
    (item) => item.dependencies ?? [],
  )) {
    const at = dependency.lastIndexOf('@');
    assert.equal(
      pkg.dependencies[dependency.slice(0, at)],
      dependency.slice(at + 1),
      dependency,
    );
  }
});

void test('every relative import of a published file ships in its item or the items it depends on', () => {
  const items = new Map(registry.items.map((item) => [item.name, item]));
  const closure = (item: Item, seen = new Set<string>()): Set<string> => {
    if (seen.has(item.name)) return new Set();
    seen.add(item.name);
    const paths = new Set((item.files ?? []).map((file) => file.path));
    for (const name of item.registryDependencies ?? []) {
      const dependency = items.get(name);
      if (dependency)
        for (const path of closure(dependency, seen)) paths.add(path);
    }
    return paths;
  };
  for (const item of registry.items) {
    const shipped = closure(item);
    for (const file of item.files ?? []) {
      if (!/\.tsx?$/.test(file.path)) continue;
      const source = readFileSync(resolve(ROOT, file.path), 'utf8');
      for (const [, specifier] of source.matchAll(/from '(\.[^']+)'/g)) {
        const base = relative(
          ROOT,
          resolve(ROOT, dirname(file.path), specifier!),
        );
        assert.ok(
          [`${base}.ts`, `${base}.tsx`].some((path) => shipped.has(path)),
          `${item.name}: ${file.path} imports ${specifier}`,
        );
      }
    }
  }
});

void test('published font mappings carry in-variable fallbacks', () => {
  const theme = registry.items.find((item) => item.name === 'gyblos-theme')
    ?.cssVars?.theme;
  assert.ok(theme);
  const fonts = Object.entries(theme).filter(([name]) =>
    name.startsWith('font-'),
  );
  assert.ok(fonts.length > 0);
  for (const [name, value] of fonts)
    for (const [, reference] of value.matchAll(/var\(([^)]*)\)/g))
      assert.ok(
        reference!.includes(','),
        `${name}: var(${reference}) has no fallback`,
      );
});
