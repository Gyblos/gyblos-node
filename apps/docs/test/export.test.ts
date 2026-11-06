// Exercises the public static site after docs:build: complete Markdown, discovery, links and page actions.
// No server, keys or external services are used; source pages are the independent coverage inventory.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const OUTPUT = join(ROOT, 'out');
const CONTENT = join(ROOT, 'content/docs');

async function pages(directory = CONTENT): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? pages(path)
        : path.endsWith('.mdx')
          ? [path]
          : [];
    }),
  );
  return nested.flat().sort();
}

const read = (path: string) => readFile(join(OUTPUT, path), 'utf8');

function route(path: string) {
  const relative = path.slice(CONTENT.length + 1);
  const locale = relative.endsWith('.es.mdx') ? 'es' : 'en';
  const slug = relative.replace(/(?:\.es)?\.mdx$/, '');
  return {
    locale,
    slug,
    html: slug === 'index' ? locale : `${locale}/${slug}`,
  };
}

void test('docs export: every authored page has complete clean Markdown and copy actions', async () => {
  for (const path of await pages()) {
    const { locale, slug, html } = route(path);
    const original = await readFile(path, 'utf8');
    const markdownPath = `markdown/${locale}/${slug}.md`;
    const markdown = await read(markdownPath);
    assert.ok(markdown.startsWith('# '), markdownPath);
    assert.doesNotMatch(
      markdown,
      /<\/?(?:Callout|Card|Cards|Steps|Step)\b|^---\s*\ntitle:/m,
    );
    assert.ok(markdown.includes(`https://docs.gyblos.com/${html}`));
    // Code fences and all quoted commands must survive the conversion unchanged.
    for (const block of original.matchAll(/```[^\n]*\n([\s\S]*?)```/g))
      assert.ok(
        markdown.includes(block[1]!.trim()),
        `${markdownPath}: missing code block`,
      );
    for (const title of original.matchAll(/<Callout[^>]*title="([^"]+)"/g))
      assert.ok(
        markdown.includes(title[1]!),
        `${markdownPath}: missing warning title`,
      );
    const page = await read(`${html}.html`);
    assert.ok(
      page.includes(`/${markdownPath}`),
      `${html}: no Markdown alternate`,
    );
    assert.ok(page.includes(locale === 'es' ? 'Copiar página' : 'Copy page'));
    assert.ok(
      page.includes(locale === 'es' ? 'Ver Markdown' : 'View Markdown'),
    );
  }
});

void test('docs export: LLM indexes cover both languages and full exports contain every page', async () => {
  const index = await read('llms.txt');
  const full = await read('llms-full.txt');
  assert.match(index, /^# Gyblos Docs\n/);
  for (const path of await pages()) {
    const { locale, slug } = route(path);
    const markdownPath = `markdown/${locale}/${slug}.md`;
    assert.ok(
      index.includes(`https://docs.gyblos.com/${markdownPath}`),
      markdownPath,
    );
    const markdown = await read(markdownPath);
    assert.ok(
      full.includes(markdown.trim()),
      `${markdownPath}: incomplete full export`,
    );
    assert.ok(
      (await read(`${locale}/llms-full.txt`)).includes(markdown.trim()),
    );
  }
});

void test('docs export: sitemap, robots and share metadata cover all translated pages', async () => {
  const sitemap = await read('sitemap.xml');
  assert.ok(
    (await read('robots.txt')).includes('https://docs.gyblos.com/sitemap.xml'),
  );
  for (const path of await pages()) {
    const { html } = route(path);
    const url = `https://docs.gyblos.com/${html}`;
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), url);
    const page = await read(`${html}.html`);
    assert.ok(page.includes('property="og:title"'));
    assert.ok(page.includes('name="twitter:card"'));
    assert.ok(page.includes('rel="canonical"'));
  }
});

void test('docs export: article links resolve to exported pages and existing anchors', async () => {
  for (const path of await pages()) {
    const { html } = route(path);
    const page = await read(`${html}.html`);
    for (const link of page.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
      const url = new URL(
        link[1]!.replaceAll('&amp;', '&'),
        `https://docs.gyblos.com/${html}`,
      );
      if (url.origin !== 'https://docs.gyblos.com') continue;
      const targetPath = decodeURIComponent(url.pathname)
        .replace(/^\//, '')
        .replace(/\/$/, '');
      const isFile = /\.(?:md|txt|xml|svg)$/.test(targetPath);
      const target = await read(isFile ? targetPath : `${targetPath}.html`);
      if (url.hash && !isFile)
        assert.ok(
          target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
          `${html}: ${url}`,
        );
    }
  }
});
