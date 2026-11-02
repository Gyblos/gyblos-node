// Allocates only owned temporary homes, runs an environment-allowlisted child and bounds output/deadline/cleanup.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ACCEPTANCE_CODES } from '@gyblos/lab-harness/acceptance/constants';
import { AcceptanceError } from '@gyblos/lab-harness/acceptance/errors';
import {
  createAcceptanceWorkspace,
  type AcceptanceWorkspace,
} from '@gyblos/lab-harness/acceptance/workspace';
import { controlObject } from '@gyblos/protocol/control-validation';

import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import { parsePaidReport } from './paid-acceptance-report';

export { parsePaidReport } from './paid-acceptance-report';

function childFailure(output: string) {
  try {
    const row = controlObject(JSON.parse(output), ['ok', 'code']);
    const code = Object.values(ACCEPTANCE_CODES).find(
      (item) => item === row.code,
    );
    if (row.ok === false && code) return new AcceptanceError(code);
  } catch {
    /* Do not reflect child output. */
  }
  return new AcceptanceError(ACCEPTANCE_CODES.FAILED);
}
async function child(workspace: AcceptanceWorkspace, signal?: AbortSignal) {
  const processChild = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL(PAID_ACCEPTANCE.worker, import.meta.url)),
    ],
    {
      cwd: workspace.root,
      env: {
        ...workspace.environment,
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SystemRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let size = 0;
  let errors = 0;
  let failed = false;
  let kill: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (processChild.exitCode !== null || processChild.signalCode !== null)
      return;
    processChild.kill('SIGTERM');
    kill ??= setTimeout(
      () => processChild.kill('SIGKILL'),
      PAID_ACCEPTANCE.killMs,
    );
  };
  const timer = setTimeout(() => {
    failed = true;
    stop();
  }, PAID_ACCEPTANCE.runMs);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  processChild.stdout.on('data', (part: Buffer) => {
    size += part.length;
    if (size > PAID_ACCEPTANCE.outputBytes) {
      failed = true;
      stop();
    } else output += part.toString('utf8');
  });
  processChild.stderr.on('data', (part: Buffer) => {
    errors += part.length;
    if (errors > PAID_ACCEPTANCE.outputBytes) {
      failed = true;
      stop();
    }
  });
  try {
    const code = await new Promise<number | null>((resolve) => {
      processChild.once('error', () => {
        failed = true;
      });
      processChild.once('close', resolve);
    });
    if (signal?.aborted) throw new AcceptanceError(ACCEPTANCE_CODES.CANCELLED);
    if (failed) throw new AcceptanceError(ACCEPTANCE_CODES.FAILED);
    if (code !== 0) throw childFailure(output);
    return parsePaidReport(output.trim());
  } finally {
    clearTimeout(timer);
    clearTimeout(kill);
    signal?.removeEventListener('abort', stop);
  }
}
export async function runPaidAcceptance(
  options: { signal?: AbortSignal } = {},
) {
  if (options.signal?.aborted)
    throw new AcceptanceError(ACCEPTANCE_CODES.CANCELLED);
  const workspace = await createAcceptanceWorkspace();
  try {
    return await child(workspace, options.signal);
  } finally {
    await workspace.close();
  }
}
