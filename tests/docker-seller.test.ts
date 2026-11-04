// The Docker seller files: Ollama on loopback with no published port, the seller in its namespace with init,
// SIGINT and grace to withdraw, the memory its headroom check needs, and an allowlisted build context.
// Offline text checks of the files; building the image is a manual step.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { DIAGNOSTICS } from '@gyblos/config';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const read = (path: string) =>
  readFileSync(join(REPOSITORY_ROOT, path), 'utf8');

void test('compose keeps Ollama on loopback, unpublished, and shares its namespace with the seller', () => {
  const compose = read('compose.yaml');
  assert.match(compose, /OLLAMA_HOST: 127\.0\.0\.1:11434/);
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.doesNotMatch(compose, /0\.0\.0\.0/);
  assert.match(compose, /network_mode: service:ollama/);
  assert.match(compose, /restart: true/);
  assert.match(compose, /create_host_path: false/);
  assert.match(compose, /env_file:\s*\n\s*- \.\/seller\.env/);
  assert.match(
    read('examples/seller-docker.toml'),
    /url = "http:\/\/127\.0\.0\.1:11434\/"/,
  );
});

void test('the seller stops with SIGINT, waits for withdrawal and has its memory headroom', () => {
  const compose = read('compose.yaml');
  assert.match(read('Dockerfile'), /^STOPSIGNAL SIGINT$/m);
  assert.match(compose, /stop_grace_period: 120s/);
  assert.match(compose, /^\s*init: true$/m);
  const limit = /mem_limit: (\d+)g/.exec(compose);
  assert.ok(limit, 'mem_limit');
  assert.ok(
    Number(limit[1]) * 1024 ** 3 > DIAGNOSTICS.minimumCgroupHeadroomBytes,
  );
});

void test('the image runs as the unprivileged node user with data in a private volume', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /install -d -o node -g node -m 0700 \/data/);
  assert.match(
    dockerfile,
    /ENV GYBLOS_HOME=\/data GYBLOS_CONFIG=\/config\/gyblos\.toml/,
  );
  assert.equal(
    statSync(join(REPOSITORY_ROOT, 'docker/entrypoint.sh')).mode & 0o111,
    0o111,
  );
});

void test('the build context is an allowlist that never admits local state or secrets', () => {
  const ignored = read('.dockerignore').split(/\r?\n/);
  assert.equal(
    ignored.find((line) => line && !line.startsWith('#')),
    '*',
  );
  for (const entry of [
    '**/node_modules',
    '**/.local',
    '**/.env',
    '**/.env.*',
    '**/*.key',
    '**/AGENTS.local.md',
    '**/evidence',
  ])
    assert.ok(ignored.includes(entry), entry);
  // Nothing at the root is admitted that could hold local state or configuration.
  for (const entry of ['!.local', '!gyblos.toml', '!seller.env', '!.git'])
    assert.equal(ignored.includes(entry), false, entry);
  assert.ok(read('.gitignore').split(/\r?\n/).includes('/seller.env'));
});
