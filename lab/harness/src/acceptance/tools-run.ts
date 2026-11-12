// Isolated local tool-loop acceptance: bounded child processes, allowlisted environment and metadata-only output.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { ACCEPTANCE_CODES } from './constants';
import {
  acceptanceAssert,
  AcceptanceError,
  assertAcceptanceActive,
} from './errors';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';
import {
  TOOL_ACCEPTANCE,
  TOOL_ACCEPTANCE_CASES,
  type ToolAcceptanceCase,
  type ToolAcceptanceReport,
  type ToolCaseReport,
} from './tools-constants';
import {
  createAcceptanceWorkspace,
  type AcceptanceWorkspace,
} from './workspace';

function report(text: string, scenario: ToolAcceptanceCase): ToolCaseReport {
  const input = controlObject(JSON.parse(text) as unknown, [
    'case',
    'generations',
    'executionDials',
    'queries',
    'discoveryReads',
    'registryReads',
    'cancellations',
    'forbiddenCalls',
    'verifiedTurns',
  ]);
  acceptanceAssert(input.case === scenario);
  return {
    case: scenario,
    generations: controlInteger(input.generations),
    executionDials: controlInteger(input.executionDials),
    queries: controlInteger(input.queries),
    discoveryReads: controlInteger(input.discoveryReads),
    registryReads: controlInteger(input.registryReads),
    cancellations: controlInteger(input.cancellations),
    forbiddenCalls: controlInteger(input.forbiddenCalls, 0, 0),
    verifiedTurns: controlInteger(input.verifiedTurns),
  };
}
function workerFailure(text: string) {
  try {
    const value = controlObject(JSON.parse(text), ['ok', 'code']);
    const known = Object.values(ACCEPTANCE_CODES).find(
      (code) => code === value.code,
    );
    if (value.ok === false && known) return new AcceptanceError(known);
  } catch {
    /* Never reflect child output or errors. */
  }
  return new AcceptanceError(ACCEPTANCE_CODES.FAILED);
}
async function childAcceptance(
  workspace: AcceptanceWorkspace,
  scenario: ToolAcceptanceCase,
  signal?: AbortSignal,
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL(TOOL_ACCEPTANCE.worker, import.meta.url)),
      scenario,
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
  let bytes = 0;
  let stderrBytes = 0;
  let failed = false;
  let timedOut = false;
  let killing: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    child.kill('SIGTERM');
    killing ??= setTimeout(
      () => child.kill('SIGKILL'),
      RECEIPT_ACCEPTANCE.killMs,
    );
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, TOOL_ACCEPTANCE.maxRunMs);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > RECEIPT_ACCEPTANCE.reportBytes) {
      failed = true;
      stop();
    } else output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > RECEIPT_ACCEPTANCE.stderrBytes) {
      failed = true;
      stop();
    }
  });
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => {
        failed = true;
      });
      child.once('close', resolve);
    });
    if (signal?.aborted) throw new AcceptanceError(ACCEPTANCE_CODES.CANCELLED);
    if (failed || timedOut) throw new AcceptanceError(ACCEPTANCE_CODES.FAILED);
    if (code !== 0) throw workerFailure(output);
    return report(output, scenario);
  } finally {
    clearTimeout(timeout);
    clearTimeout(killing);
    signal?.removeEventListener('abort', stop);
  }
}
export async function runToolAcceptance(
  options: { signal?: AbortSignal } = {},
): Promise<ToolAcceptanceReport> {
  if (options.signal) assertAcceptanceActive(options.signal);
  const cases: ToolCaseReport[] = [];
  for (const scenario of Object.values(TOOL_ACCEPTANCE_CASES)) {
    if (options.signal) assertAcceptanceActive(options.signal);
    const workspace = await createAcceptanceWorkspace();
    try {
      cases.push(await childAcceptance(workspace, scenario, options.signal));
    } catch (error) {
      throw error instanceof AcceptanceError
        ? error
        : new AcceptanceError(ACCEPTANCE_CODES.FAILED);
    } finally {
      await workspace.close();
    }
  }
  return {
    ok: true,
    nativeIroh: true,
    identityEnabled: true,
    paymentsEnabled: false,
    cases,
  };
}
