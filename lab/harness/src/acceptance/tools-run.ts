// Isolated local tool-loop acceptance: bounded child processes, allowlisted environment and metadata-only output.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { DIAGNOSTIC_OUTCOMES } from '@gyblos/runtime/constants';
import { withDiagnosticCleanup } from '@gyblos/runtime/diagnostic-cleanup';
import {
  diagnosticCause,
  type DiagnosticSink,
} from '@gyblos/runtime/diagnostics';

import { ACCEPTANCE_CODES } from './constants';
import {
  acceptanceAssert,
  AcceptanceError,
  assertAcceptanceActive,
} from './errors';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';
import { childFailure, childFrames } from './tools-child-diagnostics';
import {
  TOOL_ACCEPTANCE,
  TOOL_ACCEPTANCE_CASES,
  TOOL_DIAGNOSTICS,
  type ToolAcceptanceCase,
  type ToolAcceptanceReport,
  type ToolCaseReport,
} from './tools-constants';
import { toolDiagnostics } from './tools-diagnostics';
import {
  createAcceptanceWorkspace,
  type AcceptanceWorkspace,
} from './workspace';

function report(text: string, scenario: ToolAcceptanceCase): ToolCaseReport {
  const input = controlObject(JSON.parse(text) as unknown, [
    'case',
    'generations',
    'executionDials',
    'controlConnections',
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
    controlConnections: controlInteger(input.controlConnections),
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
  diagnostics?: DiagnosticSink,
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
    const failure = (reason: AcceptanceError['code']) =>
      childFailure({
        output,
        scenario,
        code: reason,
        exitCode: code,
        signal: child.signalCode,
        stdoutBytes: bytes,
        stderrBytes,
        timedOut,
        cancelled: signal?.aborted ?? false,
        sink: diagnostics,
      });
    if (signal?.aborted) throw failure(ACCEPTANCE_CODES.CANCELLED);
    if (failed || timedOut) throw failure(ACCEPTANCE_CODES.FAILED);
    let final: string;
    try {
      const frames = childFrames(output, scenario);
      acceptanceAssert(frames.valid);
      final = frames.final;
    } catch {
      throw failure(ACCEPTANCE_CODES.FAILED);
    }
    if (code !== 0) throw failure(workerFailure(final).code);
    try {
      return report(final, scenario);
    } catch {
      throw failure(ACCEPTANCE_CODES.FAILED);
    }
  } finally {
    clearTimeout(timeout);
    clearTimeout(killing);
    signal?.removeEventListener('abort', stop);
  }
}
export async function runToolAcceptance(
  options: { signal?: AbortSignal; diagnostics?: DiagnosticSink } = {},
): Promise<ToolAcceptanceReport> {
  if (options.signal) assertAcceptanceActive(options.signal);
  const diagnostics: DiagnosticSink =
    options.diagnostics ??
    ((record) => {
      process.stderr.write(JSON.stringify(record) + '\n');
    });
  const channel = toolDiagnostics(diagnostics);
  const cases: ToolCaseReport[] = [];
  for (const scenario of Object.values(TOOL_ACCEPTANCE_CASES)) {
    if (options.signal) assertAcceptanceActive(options.signal);
    const workspace = await createAcceptanceWorkspace();
    await withDiagnosticCleanup(
      async () => {
        cases.push(
          await childAcceptance(
            workspace,
            scenario,
            options.signal,
            diagnostics,
          ),
        );
      },
      () => workspace.close(),
      (error) =>
        channel.start().report({
          phase: TOOL_DIAGNOSTICS.phases.CLEANUP,
          scenario,
          code: ACCEPTANCE_CODES.FAILED,
          cause: diagnosticCause(error),
          outcome: DIAGNOSTIC_OUTCOMES.CLEANUP_FAILURE,
        }),
    );
  }
  return {
    ok: true,
    nativeIroh: true,
    identityEnabled: true,
    paymentsEnabled: false,
    cases,
  };
}

export { childFailure } from './tools-child-diagnostics';
