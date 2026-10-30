// Owns the command-line entrypoint for checking or materializing repository skills.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSkillLayout, materializeSkills } from './skills';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARGUMENTS = process.argv.slice(2);

function usage(): never {
  throw new Error(
    'Usage: tooling/skills-cli.ts check | materialize [--replace]',
  );
}

async function main(): Promise<void> {
  const command = ARGUMENTS[0] ?? 'check';
  if (command === 'check' && ARGUMENTS.length === 1) {
    const report = await checkSkillLayout(ROOT);
    if (report.issues.length > 0) {
      for (const issue of report.issues)
        console.error(`${issue.path}: ${issue.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Skill layout: ${report.skills.length} skills; OK.`);
    return;
  }
  if (command === 'materialize') {
    const unknownArguments = ARGUMENTS.slice(1).filter(
      (argument) => argument !== '--replace',
    );
    if (unknownArguments.length > 0) usage();
    await materializeSkills(ROOT, { replace: ARGUMENTS.includes('--replace') });
    console.log('Skill layout materialized.');
    return;
  }
  usage();
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Skill command failed.',
  );
  process.exitCode = 1;
});
