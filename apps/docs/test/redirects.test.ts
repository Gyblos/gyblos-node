import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestHarness } from 'wrangler';

void test('Cloudflare permanently redirects locale entry points to their exported pages', async (t) => {
  const server = createTestHarness({
    workers: [{ configPath: new URL('../wrangler.jsonc', import.meta.url) }],
  });
  t.after(() => server.close());
  const { url } = await server.listen();
  const origin = 'https://docs.gyblos.com';
  for (const [path, locale] of [
    ['/', 'en'],
    ['/es/', 'es'],
  ] as const) {
    const response = await fetch(new URL(path, url), { redirect: 'manual' });
    assert.equal(response.status, 301, path);
    const location = response.headers.get('location');
    assert.ok(location);
    const destination = new URL(location, new URL(path, url));
    assert.equal(
      destination.href,
      new URL('/' + locale, path === '/' ? origin : url).href,
    );
    const page = await fetch(new URL(destination.pathname, url), {
      redirect: 'manual',
    });
    assert.equal(page.status, 200);
    assert.match(
      await page.text(),
      new RegExp('<html[^>]*lang="' + locale + '"'),
    );
  }
});
