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
    const buttons = [...page.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)];
    assert.ok(
      buttons.some(([button]) =>
        button.includes(locale === 'es' ? '>Abrir en<' : '>Open in<'),
      ),
      `${html}: no assistant menu`,
    );
    const copy = [...page.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(
      ([button]) =>
        button.includes(locale === 'es' ? 'Copiar página' : 'Copy page'),
    );
    assert.ok(copy?.[0].includes('<svg'), `${html}: no copy icon`);
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

void test('docs export: all five sidebar groups have decorative icons and localized labels', async () => {
  const groups = [
    { en: 'Get started', es: 'Inicio', icon: 'compass' },
    { en: 'Sellers', es: 'Vendedores', icon: 'server' },
    { en: 'Buyers', es: 'Compradores', icon: 'plug' },
    { en: 'Reference', es: 'Referencia', icon: 'book-open' },
    { en: 'Help', es: 'Ayuda', icon: 'life-buoy' },
  ];
  for (const path of await pages()) {
    const { locale, html } = route(path);
    const output = await read(`${html}.html`);
    const buttons = [...output.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)];
    for (const group of groups) {
      const label = locale === 'es' ? group.es : group.en;
      const button = buttons.find(([button]) =>
        button.includes(`data-sidebar-icon="${group.icon}"`),
      )?.[0];
      assert.ok(button, `${html}: missing ${group.icon} group icon`);
      assert.ok(button.includes(label), `${html}: missing ${label} label`);
      const icon = button.match(
        /<svg\b[^>]*data-sidebar-icon="[^"]+"[^>]*>/,
      )?.[0];
      assert.ok(icon, `${html}: group icon is not an inline SVG`);
      assert.ok(icon.includes('aria-hidden="true"'));
      assert.ok(icon.includes('focusable="false"'));
      assert.ok(icon.includes('width="16"'));
      assert.ok(icon.includes('height="16"'));
    }
  }
});

void test('docs export: introduction and quickstart lead the sidebar once in both languages', async () => {
  for (const locale of ['en', 'es']) {
    const output = await read(`${locale}.html`);
    assert.match(output, /<h1\b[^>]*>Docs<\/h1>/);
    const sidebar = output.match(
      /<aside\b[^>]*id="nd-sidebar"[\s\S]*?<\/aside>/,
    )?.[0];
    assert.ok(sidebar, `${locale}: missing sidebar`);
    const links = [
      ...sidebar.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
    ].filter(([, href]) => href?.startsWith(`/${locale}`));
    const destinations = links.map(([, href]) => href);
    assert.deepEqual(destinations, [
      `/${locale}`, // Brand home link.
      `/${locale}`,
      `/${locale}/sellers/beta-guide`,
      `/${locale}/getting-started/beta`,
      `/${locale}/sellers/manual-install`,
      `/${locale}/sellers/register-publish`,
      `/${locale}/sellers/models-offers`,
      `/${locale}/sellers/operate`,
      `/${locale}/sellers/identity`,
      `/${locale}/buyers/use-from-code`,
      `/${locale}/reference/cli`,
      `/${locale}/reference/configuration`,
      `/${locale}/help/troubleshooting`,
    ]);
    assert.ok(links[1]?.[2]?.includes('Intro'));
    assert.ok(
      links[2]?.[2]?.includes(locale === 'es' ? 'Inicio rápido' : 'Quickstart'),
    );
  }
});

void test('docs export: troubleshooting has nested sections and retains previous deep links', async () => {
  for (const locale of ['en', 'es']) {
    const output = await read(`${locale}/help/troubleshooting.html`);
    const sections =
      locale === 'es'
        ? ['docker', 'ollama', 'motor', 'relay', 'registro', 'visibilidad']
        : ['docker', 'ollama', 'engine', 'relay', 'registration', 'visibility'];
    for (const id of sections) {
      assert.match(output, new RegExp(`<h3\\b[^>]*id="${id}"`));
      assert.ok(output.includes(`href="#${id}"`));
    }
    const previous =
      locale === 'es'
        ? [
            'empieza-por-el-estado-del-servicio',
            'errores-de-instalación',
            'configuración-rechazada',
            'motor-o-relay-no-disponible',
            'funciona-pero-no-aparece-publicado',
            'solicitudes-gratuitas-rechazadas-o-sin-actividad',
            'llaves-ausentes-estado-corrupto-o-bloqueos',
            'pide-ayuda-de-forma-segura',
          ]
        : [
            'start-with-the-service-state',
            'installation-errors',
            'configuration-rejected',
            'engine-or-relay-unavailable',
            'running-but-not-listed',
            'free-requests-refused-or-no-activity',
            'missing-keys-corrupt-state-or-locks',
            'ask-for-help-safely',
          ];
    for (const id of previous)
      assert.ok(output.includes(`id="${id}"`), `${locale}: removed #${id}`);
  }
});
