// Owns the docs site content contract (apps/docs): every page and sidebar file exists in English and
// Spanish, no page carries something shaped like a real invite code, and the output strings the seller
// guide tells sellers to look for still exist in the code that prints them. Offline; reads files only.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';

import { STATUS_RESULTS } from '@gyblos/node-app/constants';

const ROOT = join(import.meta.dirname, '..');
const CONTENT = join(ROOT, 'apps/docs/content/docs');
const GUIDE = 'sellers/beta-guide';
const SPANISH = /\.es\.(mdx|json)$/;
// An invite (apps/discovery-index/src/constants.ts) anywhere in a page, examples included.
const INVITE = /gyb_[a-z2-7]{26}/;

// Output the guide quotes verbatim, and the file that prints it.
const QUOTED_OUTPUT = [
  ['The seller is running', 'install.sh'],
  ['Docker is not running', 'install.sh'],
  ['Docker is not installed', 'install.sh'],
  ['Docker Compose v2 is missing', 'install.sh'],
  ['is too old', 'install.sh'],
  ['The relay token is empty', 'install.sh'],
  ['must have $RELAY_TOKEN_MIN to $RELAY_TOKEN_MAX characters', 'install.sh'],
  ['Ollama did not start', 'install.sh'],
  ['gyblos install:', 'install.sh'],
  ['Seller identity (public;', 'apps/node/src/cli-doctor.ts'],
  ['Registered: this seller may now publish.', 'apps/node/src/cli-register.ts'],
  ['Already registered', 'apps/node/src/cli-register.ts'],
  ['listed in the index', 'apps/node/src/cli-status.ts'],
  ['SELLER_RELAY_OFFLINE', 'packages/node/src/constants.ts'],
  ['DISCOVERY_INVITE_INVALID', 'packages/discovery-http/src/constants.ts'],
  [
    'DISCOVERY_IDENTITY_NOT_REGISTERED',
    'packages/discovery-http/src/constants.ts',
  ],
  ['DISCOVERY_RATE_LIMITED', 'packages/discovery-http/src/constants.ts'],
  ['DISCOVERY_UNAVAILABLE', 'packages/discovery-http/src/constants.ts'],
] as const;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

const guide = (suffix: string) =>
  readFile(join(CONTENT, `${GUIDE}${suffix}.mdx`), 'utf8');

void test('docs: every page and sidebar file has an English and a Spanish version', async () => {
  const all = (await files(CONTENT)).map((path) => relative(CONTENT, path));
  const english = all.filter((path) => !SPANISH.test(path)).sort();
  const spanish = all
    .filter((path) => SPANISH.test(path))
    .map((path) => path.replace(SPANISH, '.$1'))
    .sort();
  assert.ok(english.length > 0);
  assert.deepEqual(spanish, english);
});

void test('docs: no page carries an invite-shaped code', async () => {
  for (const path of await files(CONTENT))
    assert.doesNotMatch(await readFile(path, 'utf8'), INVITE, path);
});

void test('docs: the seller guide quotes output that the node still prints', async () => {
  const pages = [await guide(''), await guide('.es')];
  for (const [text, source] of QUOTED_OUTPUT) {
    const code = await readFile(join(ROOT, source), 'utf8');
    assert.ok(code.includes(text), `${source} no longer prints: ${text}`);
    // Shell variables in the source appear as their values in the guide.
    const shown = text.replace(
      '$RELAY_TOKEN_MIN to $RELAY_TOKEN_MAX',
      '32 to 512',
    );
    for (const page of pages)
      assert.ok(page.includes(shown), `the guide does not quote: ${shown}`);
  }
  for (const result of Object.values(STATUS_RESULTS))
    for (const page of pages)
      assert.ok(page.includes(`\`${result}\``), `missing result ${result}`);
});
