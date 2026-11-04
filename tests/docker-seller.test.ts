// The Docker seller (Dockerfile, compose.yaml, docker/entrypoint.sh, examples/seller-docker.toml): Ollama
// stays on loopback with no published port, the seller shares its namespace, stops with SIGINT and enough
// grace to withdraw, has the memory its headroom check needs, and never bakes local state into the image.
// Text checks only; building the image is a manual step.
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
  assert.match(compose, /- \.\/gyblos\.toml:\/config\/gyblos\.toml:ro/);
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

void test('local state, secrets and configuration never enter the build context', () => {
  const ignored = read('.dockerignore').split('\n');
  for (const entry of [
    '.local',
    '.git',
    '**/node_modules',
    '.env',
    'seller.env',
    'gyblos.toml',
    'lab/evidence',
  ])
    assert.ok(ignored.includes(entry), entry);
  assert.ok(read('.gitignore').split('\n').includes('/seller.env'));
});
