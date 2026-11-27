import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const APP_ROOT = new URL('../apps/explorer/', import.meta.url).pathname;
const SCRIPT = new URL(
  '../apps/explorer/scripts/build-registry.ts',
  import.meta.url,
).pathname;

async function fixture(registry: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-registry-build-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'components/board'), { recursive: true });
  await cp(SCRIPT, join(root, 'scripts/build-registry.ts'));
  await symlink(join(APP_ROOT, 'node_modules'), join(root, 'node_modules'));
  await writeFile(
    join(root, 'components/board/widget.ts'),
    'export const x = 1;\n',
  );
  await writeFile(join(root, 'registry.json'), JSON.stringify(registry));
  return root;
}

function run(root: string) {
  return spawnSync(
    process.execPath,
    [join(root, 'scripts/build-registry.ts')],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
  );
}

const VALID = {
  homepage: 'https://explorer.gyblos.com',
  items: [
    {
      name: 'widget',
      type: 'registry:component',
      files: [
        {
          path: 'components/board/widget.ts',
          type: 'registry:file',
          target: 'components/board/widget.ts',
        },
      ],
    },
  ],
};

void test('registry build writes each item under public/r', async () => {
  const root = await fixture(VALID);
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const built = readFileSync(join(root, 'public/r/widget.json'), 'utf8');
    assert.match(built, /export const x = 1/);
    assert.equal(existsSync(join(root, 'public/r/registry.json')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('registry item name cannot escape the output directory', async () => {
  const root = await fixture({
    ...VALID,
    items: [{ name: '../../escaped', type: 'registry:component' }],
  });
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, 'escaped.json')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('registry file path cannot read outside the app root', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'gyblos-registry-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'SECRET-CONTENT');
  const root = await fixture({
    ...VALID,
    items: [
      {
        name: 'widget',
        type: 'registry:component',
        files: [
          {
            path: join(outside, 'secret.txt'),
            type: 'registry:file',
            target: 'components/board/widget.ts',
          },
        ],
      },
    ],
  });
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
    const output = join(root, 'public/r/widget.json');
    assert.equal(
      existsSync(output) && readFileSync(output, 'utf8').includes('SECRET'),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

void test('registry file target cannot escape the consumer project', async () => {
  const root = await fixture({
    ...VALID,
    items: [
      {
        name: 'widget',
        type: 'registry:component',
        files: [
          {
            path: 'components/board/widget.ts',
            type: 'registry:file',
            target: '../../evil.ts',
          },
        ],
      },
    ],
  });
  try {
    const result = run(root);
    assert.notEqual(result.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
