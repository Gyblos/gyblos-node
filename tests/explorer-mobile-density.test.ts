import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../apps/explorer');

void test('the activity metric selector keeps three columns at every viewport width', () => {
  const source = readFileSync(
    join(ROOT, 'components/overview-chart.tsx'),
    'utf8',
  );
  const match = source.match(/className="([^"]*)"\s+role="group"/);
  assert.ok(match, 'the metric selector group has no class list');
  const classes = match[1]!.split(/\s+/);
  assert.ok(
    classes.includes('grid-cols-3'),
    `metric selector columns are breakpoint-gated: ${match[1]}`,
  );
});

void test('plain stat cards adapt to narrow containers', () => {
  const source = readFileSync(
    join(ROOT, 'components/board/stat-card.tsx'),
    'utf8',
  );
  const frame = source.match(/const frame =\s*\n?\s*'([^']*)'/);
  assert.ok(frame, 'the plain card frame class string is missing');
  assert.ok(
    frame[1]!.split(/\s+/).includes('@container'),
    'the plain card frame is not a container query context',
  );
  const tile = source.match(
    /className="([^"]*bg-stat-card-icon-background[^"]*)"/,
  );
  assert.ok(tile, 'the icon tile class list is missing');
  assert.ok(
    tile[1]!.split(/\s+/).includes('@max-[8rem]:hidden'),
    'the icon tile does not drop below 8rem containers',
  );
  const label = source.match(/cx\(\s*'min-w-0 flex-1([^']*)'/);
  assert.ok(label, 'the plain card label composition is missing');
  assert.ok(
    label[1]!.includes('@max-[8rem]:text-caption-1-medium'),
    'the label does not shrink below 8rem containers',
  );
});
