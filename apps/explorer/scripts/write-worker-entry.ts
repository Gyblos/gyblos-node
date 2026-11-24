// Writes the explorer Worker's entry (wrangler.jsonc `main`) next to the OpenNext build: OpenNext's
// handler serves the page and scheduled.ts runs the scheduled discovery read. Generated output, not
// committed (.open-next is ignored); run after `opennextjs-cloudflare build`.
import { access, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openNext = resolve(root, '.open-next/worker.js');
await access(openNext);
await writeFile(
  resolve(root, '.open-next/explorer-worker.js'),
  [
    "import openNext from './worker.js';",
    "import { scheduled } from '../scheduled.ts';",
    '',
    'export default { fetch: openNext.fetch, scheduled };',
    '',
  ].join('\n'),
);
