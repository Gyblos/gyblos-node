// Shared harness for the `gyblos seller init` tests: a temporary working directory, a scripted terminal and
// a check that the written file passes the parser and resolver node:start uses.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '@gyblos/node-app/cli';
import { parseNodeConfig } from '@gyblos/node/node-config';
import { resolveNodeConfig } from '@gyblos/node/node-config-resolve';

export const INIT = ['seller', 'init'];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
  questions: string[];
}

export async function inDirectory<T>(use: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-init-'));
  try {
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// answers === undefined runs without a terminal; otherwise each question takes the next answer.
export async function run(
  directory: string,
  args: string[],
  options: {
    answers?: string[];
    env?: Record<string, string>;
    cancelAt?: number;
  } = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const questions: string[] = [];
  const answers = options.answers ? [...options.answers] : undefined;
  const code = await runCli([...INIT, ...args], {
    env: options.env ?? {},
    cwd: directory,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    prompt: answers
      ? (question) => {
          questions.push(question);
          if (questions.length === options.cancelAt)
            return Promise.reject(new Error('aborted'));
          return Promise.resolve(answers.shift() ?? '');
        }
      : undefined,
  });
  return { code, stdout, stderr, output: stdout + stderr, questions };
}

export async function configOf(path: string) {
  const parsed = parseNodeConfig(await readFile(path, 'utf8'));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const resolved = resolveNodeConfig({ file: parsed.config, env: {} });
  assert.ok(resolved.ok, JSON.stringify(resolved));
  return { file: parsed.config, settings: resolved.settings };
}
