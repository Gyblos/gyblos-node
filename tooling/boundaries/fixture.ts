// Owns temporary, unfunded fixtures for the boundary tooling tests.
// It must never load operational roles or product modules.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BoundaryAnalysis } from './analyze.js';

export const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));

export async function fixture(
  sources: Record<string, string>,
  run: (files: string[], root: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'gyblos-boundaries-')),
  );
  const previous = process.cwd();
  try {
    const files = {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
      }),
      ...sources,
    };
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    process.chdir(root);
    await run(
      Object.keys(sources).filter(
        (name) =>
          /\.(?:[cm]?js|tsx?)$/.test(name) && !name.startsWith('node_modules/'),
      ),
      root,
    );
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
}

export function hasRule(result: BoundaryAnalysis, name: string): void {
  assert.ok(
    result.entries.some((entry) => entry.rule === name),
    `Expected ${name}`,
  );
}
