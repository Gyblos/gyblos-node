// Owns the docs site content contract (apps/docs): every page and sidebar file exists in English and
// Spanish, each language links only to its own pages, no page carries an invite or a relay token, and the
// output the seller guide tells sellers to look for is still printed by the code. Offline; reads files.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';

import { REGISTRATION } from '@gyblos/discovery-index/constants';
import { STATUS_RESULTS } from '@gyblos/node-app/constants';

const ROOT = join(import.meta.dirname, '..');
const CONTENT = join(ROOT, 'apps/docs/content/docs');
const SPANISH = /\.es\.(mdx|json)$/;
// The invite format without its anchors, so it matches anywhere in a page.
const INVITE = new RegExp(REGISTRATION.invite.source.slice(1, -1));
const RELAY_TOKEN = /GYBLOS_RELAY_TOKEN=\S/;
// Site links in MDX: href="/…" in components and ](/…) in Markdown.
const SITE_LINK = /(?:href="|\]\()\/([^"/)]*)/g;

// Output the guide quotes verbatim, and the file that prints it inside a string literal.
const QUOTED_OUTPUT = [
  ['The seller is running', 'install.sh'],
  ['Docker is not running', 'install.sh'],
  ['Docker is not installed', 'install.sh'],
  ['Docker Compose v2 is missing', 'install.sh'],
  ['is too old', 'install.sh'],
  ['The relay token is empty', 'install.sh'],
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

const read = (path: string) => readFile(join(ROOT, path), 'utf8');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The text appears inside one '…', "…" or `…` literal, not only in a comment.
const inLiteral = (code: string, text: string) =>
  new RegExp(`(['"\`])[^'"\`\\n]*${escape(text)}`).test(code);

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

void test('docs: each language links only to pages in the same language', async () => {
  for (const path of await files(CONTENT)) {
    if (!path.endsWith('.mdx')) continue;
    const locale = SPANISH.test(path) ? 'es' : 'en';
    for (const [, first] of (await readFile(path, 'utf8')).matchAll(SITE_LINK))
      assert.equal(first, locale, `${relative(ROOT, path)} links to /${first}`);
  }
});

void test('docs: no page carries an invite or a relay token', async () => {
  for (const path of await files(CONTENT)) {
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, INVITE, path);
    assert.doesNotMatch(text, RELAY_TOKEN, path);
  }
});

void test('docs: the seller handbook quotes output that the node still prints', async () => {
  const paths = (await files(CONTENT)).filter((path) => path.endsWith('.mdx'));
  const pages = await Promise.all(
    ['en', 'es'].map(async (locale) =>
      (
        await Promise.all(
          paths
            .filter((path) => SPANISH.test(path) === (locale === 'es'))
            .map((path) => readFile(path, 'utf8')),
        )
      ).join('\n'),
    ),
  );
  for (const [text, source] of QUOTED_OUTPUT) {
    assert.ok(inLiteral(await read(source), text), `${source}: ${text}`);
    for (const page of pages)
      assert.ok(page.includes(text), `the guide does not quote: ${text}`);
  }
  // install.sh prints the relay token bounds from two variables.
  const installer = await read('install.sh');
  const bound = (name: string) =>
    installer.match(new RegExp(`^${name}=(\\d+)$`, 'm'))?.[1];
  const bounds = `must have ${bound('RELAY_TOKEN_MIN')} to ${bound('RELAY_TOKEN_MAX')} characters`;
  assert.ok(
    installer.includes(
      'must have $RELAY_TOKEN_MIN to $RELAY_TOKEN_MAX characters',
    ),
  );
  for (const page of pages) assert.ok(page.includes(bounds), bounds);
  for (const result of Object.values(STATUS_RESULTS))
    for (const page of pages)
      assert.ok(page.includes(`\`${result}\``), `missing result ${result}`);
});
