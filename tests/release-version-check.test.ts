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
  assert.ok(callers.length > 0);
  const jobs = read(WORKFLOW)
    .split(/^jobs:\n/m)[1]!
    .split(/^(?= {2}[\w-]+:\n)/m);
  const using = jobs.filter((job) =>
    callers.some((name) => job.includes(`sh scripts/${name}`)),
  );
  assert.ok(using.length > 0);
  for (const job of using) {
    const name = /^ {2}([\w-]+):/.exec(job)?.[1];
    const setup = job.search(
      /^ {6}- uses: actions\/setup-node@[0-9a-f]{40}( # v[\d.]+)?\n {8}with:\n {10}node-version: 24\.22\.1\n/m,
    );
    assert.notEqual(setup, -1, `${name} has no pinned Node`);
    for (const caller of callers) {
      const run = job.indexOf(`sh scripts/${caller}`);
      if (run !== -1) assert.ok(setup < run, `${name} sets Node up too late`);
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
  const before = `$NativeVersion = '0.0.0'\n$NativeSha256 = '${'0'.repeat(64)}'\n`;
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
    assert.doesNotMatch(read(`scripts/${name}`), /\|\| valid=\$\?/, name);
});
