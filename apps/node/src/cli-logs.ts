// Read-only local diagnostics. This command never starts a node, creates a profile or contacts a peer.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { labLayout, ROLE_FILES, rolePathIn } from '@gyblos/config/home';
import {
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_READ_ERROR,
} from '@gyblos/runtime/constants';
import {
  followDiagnostics,
  readDiagnostics,
  type DiagnosticFilter,
  type DiagnosticRecord,
} from '@gyblos/runtime/diagnostics';
import { onShutdown } from '@gyblos/runtime/process';

import type { CliContext } from './cli';
import { EXIT, LOG_ROLES } from './constants';

const USAGE =
  'Usage: gyblos logs [--role buyer|seller|lab] [--follow] [--json] [--level debug|info|warn|error] [--component <name>] [--operation <name>] [--correlation-id <id>] [--limit <1..1000>]\n';
function argumentsFor(args: readonly string[]) {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        role: { type: 'string' },
        follow: { type: 'boolean' },
        json: { type: 'boolean' },
        level: { type: 'string' },
        component: { type: 'string' },
        operation: { type: 'string' },
        'correlation-id': { type: 'string' },
        limit: { type: 'string' },
      },
      allowPositionals: false,
    });
    const values = parsed.values;
    const role = Object.values(LOG_ROLES).find(
      (item) => item === (values.role ?? LOG_ROLES.SELLER),
    );
    const level = Object.values(DIAGNOSTIC_LEVELS).find(
      (item) => item === values.level,
    );
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (
      !role ||
      (values.level !== undefined && level === undefined) ||
      (limit !== undefined &&
        (!Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > DIAGNOSTIC_FORMAT.maxRecords))
    )
      return;
    const filter: DiagnosticFilter = {
      level,
      component: values.component,
      operation: values.operation,
      correlationId: values['correlation-id'],
      limit,
    };
    return {
      role,
      filter,
      follow: values.follow === true,
      json: values.json === true,
    };
  } catch {
    return undefined;
  }
}
function human(record: DiagnosticRecord) {
  return (
    `${record.at} ${record.level} ${record.component}/${record.operation} ${record.phase} ${record.code} ${record.outcome} cause=${record.cause} durationMs=${record.durationMs} correlation=${record.correlationId} version=${record.version}` +
    (record.scenario === undefined ? '' : ` case=${record.scenario}`) +
    (record.exitCode === undefined
      ? ''
      : ` exit=${record.exitCode} signal=${record.signal ?? 'none'} stdoutBytes=${record.stdoutBytes} stderrBytes=${record.stderrBytes}`) +
    '\n'
  );
}
export async function logsCommand(
  args: readonly string[],
  context: CliContext,
) {
  const parsed = argumentsFor(args);
  if (!parsed) {
    context.stderr(USAGE);
    return EXIT.failure;
  }
  const directory = resolve(
    context.cwd ?? process.cwd(),
    parsed.role === LOG_ROLES.LAB
      ? labLayout(context.env).diagnostics
      : rolePathIn(context.env, parsed.role, ROLE_FILES.diagnostics),
  );
  const output = (record: DiagnosticRecord) =>
    context.stdout(parsed.json ? JSON.stringify(record) + '\n' : human(record));
  const controller = new AbortController();
  const dispose =
    parsed.follow && !context.interrupt
      ? onShutdown(() => controller.abort())
      : () => {};
  try {
    if (parsed.follow)
      await followDiagnostics(
        directory,
        output,
        context.interrupt ?? controller.signal,
        parsed.filter,
      );
    else
      for (const record of await readDiagnostics(directory, parsed.filter))
        output(record);
    return EXIT.ok;
  } catch {
    context.stderr(DIAGNOSTIC_READ_ERROR + '\n');
    return EXIT.failure;
  } finally {
    dispose();
  }
}
