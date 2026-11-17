// Reuses the actual desktop renderer with isolated synthetic host data and a review-only brand proposal.
// Never bundles Electron main/preload, starts native services, or reads operational configuration.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AGENT_TOOLS } from '@gyblos/node/agent-setup-constants';
import { agentText } from '@gyblos/node/agent-setup-host';
import { isMain } from '@gyblos/runtime';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../../..');
const desktop = resolve(repository, 'apps/desktop');
const output = resolve(directory, 'dist');
const require = createRequire(resolve(desktop, 'package.json'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function replaceOnce(source, before, after) {
  if (
    !source.includes(before) ||
    source.indexOf(before) !== source.lastIndexOf(before)
  )
    throw new Error(
      'Desktop brand review hook changed; update the preview explicitly.',
    );
  return source.replace(before, after);
}
function reviewBrand(brand) {
  return {
    name: 'desktop-brand-review',
    enforce: 'pre',
    transform(source, id) {
      if (id === resolve(desktop, 'src/theme.ts')) {
        for (const [name, value] of Object.entries(brand.themeTokens)) {
          const pattern = new RegExp(`  ${name}: '[^']+',`);
          if (!pattern.test(source))
            throw new Error('Missing desktop brand token');
          source = source.replace(pattern, `  ${name}: '${value}',`);
        }
        source = replaceOnce(
          source,
          "'--blue': light\n      ? colors.blue\n      : 'color-mix(in srgb, var(--accent), white 35%)',",
          "'--blue': light ? colors.inkLight : colors.inkDark,",
        );
        source = replaceOnce(
          source,
          "'--focus': light\n      ? colors.blue\n      : 'color-mix(in srgb, var(--accent), white 12%)',",
          "'--focus': light ? colors.inkLight : colors.inkDark,",
        );
        return source;
      }
      if (id === resolve(desktop, 'src/ui/Signal.tsx')) {
        const start = source.indexOf('export function SignalMark(');
        const end = source.indexOf('export function SignalTrace(');
        if (start < 0 || end <= start)
          throw new Error('Missing desktop mark review hook');
        const mark = `export function SignalMark() { return createElement('span', {className:'preview-brand-mark','aria-hidden':true}, createElement('img',{className:'preview-brand-dark',src:'./gyblos-mark-solid-dark.svg',alt:''}),createElement('img',{className:'preview-brand-light',src:'./gyblos-mark-solid-light.svg',alt:''})); }\n`;
        return (
          "import { createElement } from 'react';\n" +
          source.slice(0, start) +
          mark +
          source.slice(end)
        );
      }
    },
  };
}
async function assetDigests(folder) {
  const html = await readFile(resolve(folder, 'index.html'), 'utf8');
  const names = [
    ...html.matchAll(/(?:src|href)="\.\/assets\/(index-[^"]+\.(?:js|css))"/g),
  ].map((match) => match[1]);
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        digest(await readFile(resolve(folder, 'assets', name))),
      ]),
    ),
  );
}
export async function buildPreview() {
  const { build } = await import(pathToFileURL(require.resolve('vite')).href);
  const brand = JSON.parse(
    await readFile(resolve(directory, 'brand.json'), 'utf8'),
  );
  const renderer = { root: desktop, base: './', esbuild: { jsx: 'automatic' } };
  const baseline = resolve(output, 'desktop');
  await build({ ...renderer, build: { outDir: baseline, emptyOutDir: false } });
  await build({
    ...renderer,
    plugins: [reviewBrand(brand)],
    build: { outDir: output, emptyOutDir: false },
  });
  const endpoint = {
    origin: 'http://127.0.0.1:8000',
    tokenEnv: 'GYBLOS_API_KEY',
    models: [{ id: 'qwen3-0.6b', maxOutputTokens: 256, contextTokens: 2048 }],
  };
  const examples = Object.fromEntries(
    Object.values(AGENT_TOOLS).map((tool) => [tool, agentText(tool, endpoint)]),
  );
  await build({
    root: desktop,
    publicDir: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: output,
      emptyOutDir: false,
      lib: {
        entry: resolve(directory, 'browser.ts'),
        name: 'GyblosPreview',
        formats: ['iife'],
        fileName: () => 'preview.js',
      },
      rollupOptions: {
        output: {
          footer: `GyblosPreview.startPreview(${JSON.stringify(examples)});`,
        },
      },
    },
  });
  for (const name of [
    'preview.css',
    'gyblos-mark-solid-dark.svg',
    'gyblos-mark-solid-light.svg',
  ])
    await copyFile(resolve(directory, name), resolve(output, name));
  const html = await readFile(resolve(output, 'index.html'), 'utf8');
  await writeFile(
    resolve(output, 'index.html'),
    html
      .replace(
        '<title>Gyblos</title>',
        '<title>Gyblos · Design preview · Example data</title>',
      )
      .replace(
        '    <script type="module"',
        '    <script src="./preview.js"></script>\n    <link rel="stylesheet" href="./preview.css" />\n    <script type="module"',
      ),
  );
  await writeFile(
    resolve(output, 'source-manifest.json'),
    JSON.stringify(
      {
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repository,
          encoding: 'utf8',
        }).trim(),
        rendererSource: 'apps/desktop',
        baselineAssets: await assetDigests(baseline),
        previewAssets: await assetDigests(output),
        brand,
        syntheticData: true,
        nativeServices: false,
      },
      null,
      2,
    ) + '\n',
  );
  return output;
}
if (isMain(import.meta.url)) await buildPreview();
