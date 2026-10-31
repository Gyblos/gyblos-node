// Runs real role startup in a child with a fresh home and an allowlisted environment; never inherits credentials.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  controlArray,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';

import { ACCEPTANCE_CODES, ACCEPTANCE_INDEX } from './constants';
import {
  acceptanceAssert,
  AcceptanceError,
  assertAcceptanceActive,
} from './errors';
import { COLLECTOR_ACCEPTANCE } from './receipt-collector-constants';
import {
  RECEIPT_ACCEPTANCE,
  RECEIPT_ACCEPTANCE_CASES,
  type ReceiptAcceptanceReport,
} from './receipt-constants';
import {
  createAcceptanceWorkspace,
  type AcceptanceWorkspace,
} from './workspace';

function report(text: string): ReceiptAcceptanceReport {
  const value: unknown = JSON.parse(text);
  const input = controlObject(value, [
    'ok',
    'nativeIroh',
    'paymentsEnabled',
    'index',
    'cases',
    'answers',
    'engineAttempts',
    'confirmed',
    'collectorStored',
    'collectorDuplicates',
    'collectorRestarts',
    'collectorRefusals',
    'externalCalls',
    'discoveryReads',
    'identityEnabled',
    'registryReads',
    'forbiddenRpcMethods',
    'identityRefusals',
  ]);
  acceptanceAssert(
    input.ok === true &&
      input.nativeIroh === true &&
      input.identityEnabled === true &&
      input.paymentsEnabled === false &&
      input.index === ACCEPTANCE_INDEX,
  );
  const cases = controlArray(
    input.cases,
    Object.keys(RECEIPT_ACCEPTANCE_CASES).length,
  ).map((value) => {
    const known = Object.values(RECEIPT_ACCEPTANCE_CASES).find(
      (item) => item === value,
    );
    acceptanceAssert(known);
    return known;
  });
  acceptanceAssert(
    JSON.stringify(cases) ===
      JSON.stringify(Object.values(RECEIPT_ACCEPTANCE_CASES)),
  );
  const collectorStored = controlInteger(input.collectorStored, 2);
  acceptanceAssert(
    collectorStored === input.confirmed &&
      input.collectorDuplicates === collectorStored &&
      input.collectorRestarts === 1 &&
      input.collectorRefusals === COLLECTOR_ACCEPTANCE.refusals,
  );
  return {
    ok: true,
    nativeIroh: true,
    paymentsEnabled: false,
    identityEnabled: true,
    registryReads: controlInteger(input.registryReads, 1),
    forbiddenRpcMethods: controlInteger(input.forbiddenRpcMethods, 0, 0),
    identityRefusals: controlInteger(input.identityRefusals, 1),
    index: ACCEPTANCE_INDEX,
    cases,
    answers: controlInteger(input.answers),
    engineAttempts: controlInteger(input.engineAttempts),
    confirmed: controlInteger(input.confirmed),
    collectorStored,
    collectorDuplicates: controlInteger(input.collectorDuplicates),
    collectorRestarts: controlInteger(input.collectorRestarts),
    collectorRefusals: controlInteger(input.collectorRefusals),
    externalCalls: controlInteger(input.externalCalls),
    discoveryReads: controlInteger(input.discoveryReads),
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
  signal?: AbortSignal,
) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL(RECEIPT_ACCEPTANCE.worker, import.meta.url)),
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
  }, RECEIPT_ACCEPTANCE.maxRunMs);
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
    return report(output);
  } finally {
    clearTimeout(timeout);
    clearTimeout(killing);
    signal?.removeEventListener('abort', stop);
  }
}
export async function runReceiptAcceptance(
  options: { signal?: AbortSignal } = {},
): Promise<ReceiptAcceptanceReport> {
  if (options.signal) assertAcceptanceActive(options.signal);
  const workspace = await createAcceptanceWorkspace();
  try {
    return await childAcceptance(workspace, options.signal);
  } catch (error) {
    throw error instanceof AcceptanceError
      ? error
      : new AcceptanceError(ACCEPTANCE_CODES.FAILED);
  } finally {
    await workspace.close();
  }
}
