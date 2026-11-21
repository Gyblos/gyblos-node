// Protects the explorer's published copies of its own facts: the registry's gyblos-theme carries the same
// colors, light and dark, as the explorer's CSS tokens and maps the same Tailwind names; llms.txt states
// the range presets and default, the buyer threshold, the collector's longest range and the public
// sources the code uses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { DISPLAY, RANGE } from '@gyblos/explorer/constants';
import { AGGREGATES } from '@gyblos/metrics-collector/constants';

const ROOT = resolve(import.meta.dirname, '../apps/explorer');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

// `--name: value;` declarations of one CSS block, from its opening line to its closing brace.
function declarations(css: string, opening: string) {
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
  const light = declarations(css, ':root {');
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
  const presets = RANGE.presets.map((days) => `\`?${RANGE.param}=${days}\``);
  assert.ok(
    llms.includes(
      `last ${RANGE.presets.join(', ').replace(/, (\d+)$/, ' or $1')} days`,
    ),
  );
  for (const preset of presets) assert.ok(llms.includes(preset), preset);
  assert.ok(llms.includes(`${RANGE.defaultDays} is the default`));
  assert.ok(llms.includes(`below ${DISPLAY.minPublicBuyers}`));
  assert.ok(llms.includes(`"< ${DISPLAY.minPublicBuyers}"`));
  assert.equal(DISPLAY.minPublicBuyers, AGGREGATES.minPublicBuyers);
  assert.ok(llms.includes(`at most ${AGGREGATES.maxRangeDays} days`));
  // The public sources are the explorer's default ones.
  const config = read('lib/config.ts');
  for (const binding of ['GYBLOS_DISCOVERY_URL', 'GYBLOS_COLLECTOR_URL']) {
    const source = new RegExp(`${binding} \\?\\? '([^']+)'`).exec(config)?.[1];
    assert.ok(source, binding);
    assert.ok(llms.includes(`(${source}/`), source);
  }
});
