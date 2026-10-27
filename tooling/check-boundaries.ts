// Owns enforcing architectural checks over the repository's source inventory.
// It must not start applications, inspect local roles, or conceal analyzer failures.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from './boundaries/analyze';
import { sourceFiles } from './boundaries/inventory';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARGUMENTS = process.argv.slice(2);

async function main() {
  if (ARGUMENTS.some((argument) => argument !== '--json'))
    throw new Error('Supported options: --json.');
  process.chdir(ROOT);
  const result = await analyze(await sourceFiles(ROOT), ROOT);
  const report = {
    modules: result.modules,
    current: result.entries.length,
    violations: result.entries,
  };
  if (ARGUMENTS.includes('--json'))
    console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `Boundary analysis: ${report.modules} modules; ${report.current} violations.`,
    );
    for (const entry of report.violations)
      console.log(`${entry.rule}: ${entry.source} -> ${entry.target}`);
  }
  if (report.current > 0) process.exitCode = 1;
}

main().catch(() => {
  console.error(
    'Boundary analysis failed. Check dependency installation, source resolution and configuration.',
  );
  process.exitCode = 1;
});
