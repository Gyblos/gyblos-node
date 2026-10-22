// Owns enforcing architectural checks and explicit empty-baseline updates.
// It must not start applications, inspect local roles, or conceal analyzer failures.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format } from 'prettier';

import {
  analyze,
  compareBaseline,
  validateBaseline,
} from './boundaries/analyze.js';
import { sourceFiles } from './boundaries/inventory.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'tooling/boundaries-baseline.json');
const ARGUMENTS = process.argv.slice(2);
const BOUNDARY_MODE = 'enforcing';

async function main() {
  if (
    ARGUMENTS.some(
      (argument) => !['--update-baseline', '--json'].includes(argument),
    )
  )
    throw new Error('Supported options: --json, --update-baseline.');
  process.chdir(ROOT);
  const result = await analyze(await sourceFiles(ROOT), ROOT);
  const update = ARGUMENTS.includes('--update-baseline');
  const baseline = update
    ? result.entries
    : validateBaseline(JSON.parse(await readFile(BASELINE, 'utf8')));
  if (update && result.entries.length > 0)
    throw new Error('An enforcing baseline must remain empty.');
  if (update)
    await writeFile(
      BASELINE,
      await format(JSON.stringify(result.entries), { parser: 'json' }),
    );
  const report = {
    mode: BOUNDARY_MODE,
    modules: result.modules,
    ...compareBaseline(result.entries, baseline),
    violations: result.entries,
  };
  if (ARGUMENTS.includes('--json'))
    console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `Boundary analysis: ${BOUNDARY_MODE}; ${report.modules} modules.`,
    );
    console.log(
      `Current: ${report.current}; baseline: ${report.baseline}; new: ${report.added.length}; resolved: ${report.resolved.length}.`,
    );
    for (const entry of report.violations)
      console.log(`${entry.rule}: ${entry.source} -> ${entry.target}`);
    if (update) console.log('Baseline explicitly updated.');
  }
  if (report.current > 0 || report.baseline > 0) process.exitCode = 1;
}

main().catch(() => {
  console.error(
    'Boundary analysis failed. Check dependency installation, source resolution, configuration and baseline format.',
  );
  process.exitCode = 1;
});
