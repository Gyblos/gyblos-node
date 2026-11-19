// Reuses the actual desktop renderer with isolated synthetic host data and a review-only brand proposal.
// Never bundles Electron main/preload, starts native services, or reads operational configuration.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InlineConfig } from 'vite';

import { AGENT_TOOLS } from '@gyblos/node/agent-setup-constants';
import { agentText } from '@gyblos/node/agent-setup-host';
import { isMain } from '@gyblos/runtime';

import { brand, isolatePreviewBuild, reviewBrand } from './brand-build';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../../..');
const desktop = resolve(repository, 'apps/desktop');
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
async function assetDigests(folder: string) {
  const html = await readFile(resolve(folder, 'index.html'), 'utf8');
  const names = [
    ...html.matchAll(/(?:src|href)="\.\/assets\/(index-[^"]+\.(?:js|css))"/g),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        digest(await readFile(resolve(folder, 'assets', name))),
      ]),
    ),
  );
}
export async function buildPreview(output = resolve(directory, 'dist')) {
  const { build: viteBuild } = await import('vite');
  const build = (config: InlineConfig) =>
    viteBuild(isolatePreviewBuild(config));
  const renderer: InlineConfig = {
    root: desktop,
    base: './',
    esbuild: { jsx: 'automatic' },
  };
  const baseline = resolve(output, 'desktop');
  await build({ ...renderer, build: { outDir: baseline, emptyOutDir: false } });
  await build({
    ...renderer,
    plugins: [reviewBrand(desktop)],
    build: { outDir: output, emptyOutDir: false },
  });
  const endpoint = {
    origin: 'http://127.0.0.1:8000',
    tokenEnv: 'GYBLOS_API_KEY',
    models: [{ id: 'qwen3-0.6b', maxOutputTokens: 256, contextTokens: 2048 }],
  };
  const forModel = (model: string) =>
    Object.fromEntries(
      Object.values(AGENT_TOOLS).map((tool) => [
        tool,
        agentText(tool, {
          ...endpoint,
          models: [{ ...endpoint.models[0]!, id: model }],
        }),
      ]),
    );
  const examples = {
    usdc: forModel('qwen3-0.6b'),
    paypal: forModel('qwen3:0.6b'),
  };
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
    'buttons.html',
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
