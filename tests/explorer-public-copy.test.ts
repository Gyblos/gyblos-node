// Protects the explorer's published copies of its own facts: the registry's gyblos-theme carries the same
// colors, light and dark, as the explorer's CSS tokens and maps the same Tailwind names; llms.txt states
// the range presets and default, the buyer threshold, the collector's longest range and the public
// sources the code uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { INDEX_ROUTES } from '@gyblos/discovery-index/constants';
import { DISPLAY, PAGES, PAGING, RANGE } from '@gyblos/explorer/constants';
import {
  AGGREGATES,
  COLLECTOR_ROUTES,
} from '@gyblos/metrics-collector/constants';

const ROOT = resolve(import.meta.dirname, '../apps/explorer');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

// `--name: value;` declarations of one CSS block, from its opening line to its closing brace, with
// comments removed first so a commented-out token never counts.
function declarations(source: string, opening: string) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = css.indexOf(opening);
  assert.ok(start >= 0, `missing ${opening}`);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1]!,
      match[2]!.trim(),
    ]),
  );
}
// A token's color, following var(--x) references within the same scheme.
function resolved(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  assert.ok(value, `missing --${name}`);
  const reference = /^var\(--([\w-]+)\)$/.exec(value);
  return reference ? resolved(tokens, reference[1]!) : value;
}

void test('the registry theme has the CSS tokens colors, light and dark, and the same Tailwind names', () => {
  const css = read('app/globals.css');
  // The top-level block: the dark one nests its own `:root {` inside the media query.
  assert.ok(
    css.indexOf('\n:root {') < css.indexOf('@media'),
    'top-level :root first',
  );
  const light = declarations(css, '\n:root {');
  const dark = {
    ...light,
    ...declarations(css, '@media (prefers-color-scheme: dark)'),
  };
  const theme = declarations(css, '@theme inline {');
  const registry = JSON.parse(read('registry.json')) as {
    items: {
      name: string;
      cssVars?: Record<string, Record<string, string>>;
    }[];
  };
  const vars = registry.items.find(
    (item) => item.name === 'gyblos-theme',
  )?.cssVars;
  assert.ok(vars?.light && vars.dark && vars.theme);
  for (const [scheme, tokens] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    const published: Record<string, string> = vars[scheme]!;
    // The same tokens both ways: none missing from the registry, none it publishes that the CSS lacks.
    assert.deepEqual(
      Object.keys(published).sort(),
      Object.keys(tokens).sort(),
      scheme,
    );
    for (const name of Object.keys(published) as string[])
      assert.equal(
        published[name],
        resolved(tokens, name),
        `${scheme} ${name}`,
      );
  }
  // Every color token the CSS maps for Tailwind is published, with the same mapping, and no other.
  const colors = Object.fromEntries(
    Object.entries(theme).filter(([name]) => name.startsWith('color-')),
  );
  assert.deepEqual(vars.theme, colors);
});

void test('llms.txt states the range presets, the buyer threshold, the longest range and the sources', () => {
  const llms = read('public/llms.txt');
  assert.ok(
    llms.includes(
      `own ${RANGE.presets.join(', ').replace(/, (\d+)$/, ' or $1')} day control`,
    ),
  );
  for (const { param } of Object.values(RANGE.sections))
    assert.ok(llms.includes(`\`${param}\``), param);
  assert.ok(llms.includes(`; ${RANGE.defaultDays} is the default`));
  assert.ok(llms.includes(`An older \`${RANGE.param}\` link`));
  assert.ok(llms.includes(` below ${DISPLAY.minPublicBuyers} `));
  assert.ok(llms.includes(`"< ${DISPLAY.minPublicBuyers}"`));
  assert.equal(DISPLAY.minPublicBuyers, AGGREGATES.minPublicBuyers);
  assert.ok(llms.includes(` at most ${AGGREGATES.maxRangeDays} days`));
  // The public sources are the explorer's default hosts and the routes those services serve.
  const config = read('lib/config.ts');
  const origins = ['GYBLOS_DISCOVERY_URL', 'GYBLOS_COLLECTOR_URL'].map(
    (binding) => {
      const url = new RegExp(`${binding}\\s*\\?\\?\\s*'([^']+)'`).exec(
        config,
      )?.[1];
      assert.ok(url, binding);
      return new URL(url).origin;
    },
  );
  const [discovery, collector] = origins;
  for (const route of [
    `${discovery}${INDEX_ROUTES.MODELS})`,
    `\`${INDEX_ROUTES.SELLERS}?model=`,
    `\`${INDEX_ROUTES.UPTIME}?node=`,
    `\`${INDEX_ROUTES.NETWORK}\``,
    `${collector}${COLLECTOR_ROUTES.STATS_NETWORK})`,
    `\`${COLLECTOR_ROUTES.STATS_MODELS}\``,
    `\`${COLLECTOR_ROUTES.STATS_CHAIN}\``,
    `\`${COLLECTOR_ROUTES.STATS_CHAIN_TXS}\``,
  ])
    assert.ok(llms.includes(route), route);
});

void test('llms.txt states the table paging parameters and the seller page', () => {
  const llms = read('public/llms.txt');
  assert.ok(llms.includes(`${PAGING.rowsPerPage} rows per page`));
  for (const param of [
    ...Object.values(PAGING.params),
    ...Object.values(PAGING.sortParams),
    ...Object.values(RANGE.sections).map((section) => section.param),
    ...Object.values(PAGES),
  ])
    assert.ok(llms.includes(`\`${param}\``), param);
  assert.ok(llms.includes(`\`${PAGES.sellers}/<NodeId>\``));
  assert.ok(
    llms.includes(
      "A section's range switch returns only that section's tables to page 1",
    ),
  );
});
