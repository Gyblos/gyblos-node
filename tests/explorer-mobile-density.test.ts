import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../apps/explorer');

void test('the activity metric selector keeps a dense multi-column grid at every viewport width', () => {
  const source = readFileSync(
    join(ROOT, 'components/overview-chart.tsx'),
    'utf8',
  );
  const match = source.match(/className="([^"]*)"\s+role="group"/);
  assert.ok(match, 'the metric selector group has no class list');
  const classes = match[1]!.split(/\s+/);
  assert.ok(
    classes.includes('grid-cols-2'),
    `small phones need two columns so the fixed-width baseline chip never overflows: ${match[1]}`,
  );
  assert.ok(
    classes.includes('min-[420px]:grid-cols-3'),
    `three columns only where the card interior fits the chip: ${match[1]}`,
  );
});

void test('plain stat cards adapt to narrow containers without breaking the subgrid', () => {
  const source = readFileSync(
    join(ROOT, 'components/board/stat-card.tsx'),
    'utf8',
  );
  const frame = source.match(/const frame =\s*\n?\s*'([^']*)'/);
  assert.ok(frame, 'the plain card frame class string is missing');
  assert.ok(
    !frame[1]!.split(/\s+/).includes('@container'),
    'a size container on the frame establishes an independent formatting context, which kills grid-rows-subgrid',
  );
  const row = source.match(/className="([^"]*flex items-center gap-2[^"]*)"/);
  assert.ok(row, 'the plain card label row class list is missing');
  assert.ok(
    row[1]!.split(/\s+/).includes('@container'),
    'the label row is not the narrow-container query context',
  );
  const tile = source.match(
    /className="([^"]*bg-stat-card-icon-background[^"]*)"/,
  );
  assert.ok(tile, 'the icon tile class list is missing');
  assert.ok(
    tile[1]!.split(/\s+/).includes('@max-[7rem]:hidden'),
    'the icon tile does not drop below 7rem containers',
  );
  const label = source.match(/cx\(\s*'min-w-0 flex-1([^']*)'/);
  assert.ok(label, 'the plain card label composition is missing');
  assert.ok(
    label[1]!.includes('@max-[7rem]:text-caption-1-medium'),
    'the label does not shrink below 7rem containers',
  );
});

void test('dense query controls stay compact on coarse pointers', () => {
  const pagination = readFileSync(
    join(ROOT, 'boardui/components/base/pagination/pagination.tsx'),
    'utf8',
  );
  assert.ok(
    !/(^|[^\w-])size-11/.test(pagination),
    'pagination cells and steps must not use primary-touch sizing',
  );
  const chart = readFileSync(
    join(ROOT, 'components/overview-chart.tsx'),
    'utf8',
  );
  assert.ok(
    !/size-11/.test(chart),
    'month chevrons must not use primary-touch sizing',
  );
  const segmented = readFileSync(
    join(ROOT, 'components/board/segmented-control.tsx'),
    'utf8',
  );
  assert.ok(
    !/min-h-11|min-w-11/.test(segmented),
    'segmented options must not use primary-touch sizing',
  );
});

void test('interactive controls share the rounded-lg control radius', () => {
  const pagination = readFileSync(
    join(ROOT, 'boardui/components/base/pagination/pagination.tsx'),
    'utf8',
  );
  const radii = pagination.match(/rounded-(sm|md|2lg)/g) ?? [];
  assert.deepEqual(
    radii,
    [],
    `pagination keeps off-scale radii: ${radii.join(', ')}`,
  );
  const chart = readFileSync(
    join(ROOT, 'components/overview-chart.tsx'),
    'utf8',
  );
  const chevron = chart.match(
    /className="(grid size-[^"]*place-items-center[^"]*)"/,
  );
  assert.ok(chevron, 'the month chevron class list is missing');
  assert.ok(
    chevron[1]!.includes('rounded-lg'),
    'month chevrons do not use the control radius',
  );
  const segmented = readFileSync(
    join(
      ROOT,
      'boardui/components/base/segmented-control/segmented-control.tsx',
    ),
    'utf8',
  );
  assert.ok(
    !segmented.includes('rounded-2lg'),
    'the segmented control wrapper keeps the off-scale radius',
  );
});
