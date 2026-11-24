import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const NEWER = join(REPOSITORY_ROOT, 'scripts/semver-newer.ts');
const WORKFLOW = '.github/workflows/release-seller-image.yml';
const read = (path: string) =>
  readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

void test('every release job that compares versions runs the script on the pinned Node', () => {
  const callers = readdirSync(join(REPOSITORY_ROOT, 'scripts')).filter(
    (name) =>
      name.endsWith('.sh') &&
      read(`scripts/${name}`).includes('semver-newer.ts'),
  );
  assert.notEqual(callers.length, 0);
  const jobs: string[][] = [];
  const workflow = read(WORKFLOW);
  for (const line of workflow
    .slice(workflow.indexOf('\njobs:\n') + 1)
    .split('\n')
    .slice(1)) {
    if (line.startsWith('  ') && !line.startsWith('   ') && line.endsWith(':'))
      jobs.push([]);
    jobs.at(-1)?.push(line);
  }
  const affected = jobs.filter((lines) =>
    callers.some((name) =>
      lines.some((line) => line.includes('sh scripts/' + name)),
    ),
  );
  assert.notEqual(affected.length, 0);
  for (const lines of affected) {
    const name = lines[0]?.trim();
    const setup = lines.findIndex(
      (line, index) =>
        line.startsWith('      - uses: actions/setup-node@') &&
        lines[index + 1] === '        with:' &&
        lines[index + 2] === '          node-version: 24.22.1',
    );
    assert.notEqual(setup, -1, name + ' has no pinned Node');
    for (const caller of callers) {
      const run = lines.findIndex((line) =>
        line.includes('sh scripts/' + caller),
      );
      if (run !== -1)
        assert.equal(
          Math.sign(setup - run),
          -1,
          name + ' sets Node up too late',
        );
    }
  }
});

void test('a version check accepts one valid version and nothing else', () => {
  const check = (...args: string[]) =>
    spawnSync(process.execPath, [NEWER, ...args]).status;
  for (const version of ['0.1.0', '0.1.0-beta.12', '10.20.30-rc.1.x'])
    assert.equal(check(version), 0, version);
  for (const version of ['', 'x', '01.0.0', '1.0', 'v1.0.0', '1.0.0+build'])
    assert.equal(check(version), 2, version);
  assert.equal(check(), 2);
});

void test('a release script refuses to continue when the version check cannot run', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'gyblos-release-node-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'node'), '#!/bin/sh\nexit 1\n', {
    mode: 0o755,
  });
  const target = join(directory, 'install.ps1');
  const before = [
    "$NativeVersion = '0.0.0'",
    "$NativeSha256 = '" + '0'.repeat(64) + "'",
    '',
  ].join('\n');
  writeFileSync(target, before);
  const result = spawnSync(
    'sh',
    [
      join(REPOSITORY_ROOT, 'scripts/pin-installer-windows.sh'),
      '1.2.3',
      'a'.repeat(64),
      target,
    ],
    {
      cwd: directory,
      env: { PATH: `${directory}:/usr/bin:/bin` },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(target, 'utf8'), before);
  for (const name of readdirSync(join(REPOSITORY_ROOT, 'scripts')).filter(
    (file) => file.endsWith('.sh'),
  ))
    assert.ok(!read('scripts/' + name).includes('|| valid=$?'), name);
});
