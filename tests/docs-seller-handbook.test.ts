// Verifies the public seller handbook as a connected journey and executes its complete TOML examples.
// Offline: only source files and pure public configuration entries; never reads operator state.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { parseNodeConfig } from '@gyblos/node/node-config';
import { sellerSettings } from '@gyblos/node/seller-settings';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

const CONTENT = join(import.meta.dirname, '../apps/docs/content/docs');
const JOURNEY = [
  'index',
  'getting-started/beta',
  'sellers/beta-guide',
  'sellers/register-publish',
  'sellers/models-offers',
  'sellers/operate',
  'sellers/identity',
  'reference/cli',
  'reference/configuration',
  'help/troubleshooting',
];

async function authored(directory = CONTENT): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? authored(path)
        : path.endsWith('.mdx')
          ? [path]
          : [];
    }),
  );
  return nested.flat();
}

const page = (slug: string, locale: string) =>
  readFile(join(CONTENT, `${slug}${locale === 'es' ? '.es' : ''}.mdx`), 'utf8');

void test('docs handbook: both sidebars expose the complete seller journey without orphan pages', async () => {
  for (const locale of ['en', 'es']) {
    const reached: string[] = [];
    async function visit(directory: string) {
      const path = join(
        CONTENT,
        directory,
        `meta${locale === 'es' ? '.es' : ''}.json`,
      );
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      assert.ok(value && typeof value === 'object' && 'pages' in value);
      assert.ok(Array.isArray(value.pages));
      for (const entry of value.pages) {
        assert.equal(typeof entry, 'string');
        const slug = directory ? `${directory}/${entry}` : entry;
        if (JOURNEY.includes(slug)) {
          const text = await page(slug, locale);
          assert.match(text, /^---\ntitle: .+\ndescription: .+\n---/);
          assert.ok(text.length > 500, slug);
          reached.push(slug);
        } else await visit(slug);
      }
    }
    await visit('');
    assert.deepEqual(reached.sort(), [...JOURNEY].sort(), locale);
    const inventory = (await authored())
      .filter((path) => path.endsWith('.es.mdx') === (locale === 'es'))
      .map((path) =>
        path.slice(CONTENT.length + 1).replace(/(?:\.es)?\.mdx$/, ''),
      );
    assert.deepEqual(
      reached.sort(),
      inventory.sort(),
      `${locale}: orphan page`,
    );
  }
});

void test('docs handbook: complete configuration examples validate and resolve for the free seller', async () => {
  for (const locale of ['en', 'es']) {
    let checked = 0;
    for (const slug of JOURNEY) {
      for (const block of (await page(slug, locale)).matchAll(
        /```toml\n([\s\S]*?)```/g,
      )) {
        if (!/^version = 1$/m.test(block[1]!)) continue;
        const result = parseNodeConfig(block[1]!);
        assert.ok(result.ok, `${locale}/${slug}: ${JSON.stringify(result)}`);
        const settings = sellerSettings(result.config, {});
        assert.ok(settings.offers.length > 0, slug);
        assert.ok(
          settings.offers.every(
            (offer) => offer.offer.kind === OFFER_PRICING_KINDS.FREE,
          ),
          slug,
        );
        checked++;
      }
    }
    assert.ok(
      checked >= 2,
      `${locale}: expected complete configuration and edited-offer examples`,
    );
  }
});

void test('docs handbook: English and Spanish preserve identical executable examples', async () => {
  for (const slug of JOURNEY) {
    const blocks = (text: string) =>
      [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[0]);
    assert.deepEqual(
      blocks(await page(slug, 'es')),
      blocks(await page(slug, 'en')),
      slug,
    );
  }
});
