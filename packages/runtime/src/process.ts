// Child-process helpers: spawn, stop with SIGKILL fallback, port-free and readiness polling, main checks,
// and shutdown signal handling.
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { once } from 'node:events';
import { write } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { RETRIES, TIMEOUTS } from '@gyblos/config';

export const spawnChild = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => spawn(command, args, options);

export const isMain = (moduleUrl: string) =>
  !!process.argv[1] && pathToFileURL(process.argv[1]).href === moduleUrl;

// Windows also stops a console program with Ctrl+Break (SIGBREAK); SIGTERM never arrives there.
const STOP_SIGNALS: readonly NodeJS.Signals[] =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM'];

// What a supervising parent sends over the IPC channel to stop its child like a first SIGINT: Windows has
// no signal one process can send another to stop it gracefully.
export const STOP_MESSAGE = 'gyblos:stop';

// Listens for STOP_MESSAGE when this process has an IPC channel; the returned function stops listening.
// The channel never keeps the process alive: the daemon's own work does.
function onStopMessage(handler: () => void) {
  if (!process.send) return () => {};
  const listener = (message: unknown) => {
    if (message === STOP_MESSAGE) handler();
  };
  process.on('message', listener);
  process.channel?.unref();
  return () => process.removeListener('message', listener);
}

export function onShutdown(handler: () => void) {
  for (const signal of STOP_SIGNALS) process.once(signal, handler);
  return () => {
    for (const signal of STOP_SIGNALS) process.removeListener(signal, handler);
  };
}

// Descriptor writes report failures through a callback rather than emitting Writable errors.
// Reporting is best-effort and must not interrupt state cleanup.
function writeShutdownNotice(text: string) {
  write(process.stderr.fd, text, () => undefined);
}

// Resolves `signalled` on the first SIGINT/SIGTERM (or STOP_MESSAGE from a supervisor) and keeps a listener installed until `dispose()`, so
// a repeated Ctrl-C while the caller stops prints a notice instead of killing the process mid-write.
export function shutdownSignal(
  notice: (text: string) => void = writeShutdownNotice,
) {
  let resolve: () => void = () => {};
  const signalled = new Promise<void>((done) => {
    resolve = done;
  });
  let received = 0;
  const handler = () => {
    received++;
    if (received === 1) resolve();
    else if (received === 2) {
      try {
        notice(
          'Stopping: finishing state writes and withdrawing; please wait (Ctrl-C again is ignored).\n',
        );
      } catch {
        // A custom notice or invalid descriptor must never abort the protected stop.
      }
    }
  };
  for (const signal of STOP_SIGNALS) process.on(signal, handler);
  const stopListening = onStopMessage(handler);
  return {
    signalled,
    dispose() {
      for (const signal of STOP_SIGNALS)
        process.removeListener(signal, handler);
      stopListening();
    },
  };
}

export async function stopChild(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  timeoutMs: number = TIMEOUTS.stop,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
}

export async function assertPortFree(
  url: string,
  error: () => Error = () => new Error('Host requires an unused local port.'),
) {
  try {
    await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUTS.readinessRequest),
    });
  } catch {
    return;
  }
  throw error();
}

export async function waitReady(
  child: ChildProcess,
  url: string,
  options: {
    signal?: AbortSignal;
    expectedRunId?: string;
    attempts?: number;
    requestTimeout?: number;
    onMismatch?: () => Error;
    startupError?: () => boolean;
    exitMessage?: string;
    timeoutMessage?: string;
    checkSignalCode?: boolean;
    retryResponseErrors?: boolean;
    parseBody?: boolean;
  } = {},
) {
  for (
    let attempt = 0;
    attempt < (options.attempts ?? RETRIES.startup);
    attempt++
  ) {
    options.signal?.throwIfAborted();
    if (
      child.exitCode !== null ||
      (options.checkSignalCode !== false && child.signalCode !== null) ||
      options.startupError?.()
    )
      throw new Error(options.exitMessage ?? 'Host exited during startup.');
    let mismatchError: Error | undefined;
    let responseWasOk = false;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(
          options.requestTimeout ?? TIMEOUTS.readinessRequest,
        ),
      });
      if (response.ok) {
        responseWasOk = true;
        const body =
          options.parseBody === false
            ? {}
            : ((await response.json()) as { runId?: string });
        if (options.expectedRunId && body.runId !== options.expectedRunId)
          throw (mismatchError =
            options.onMismatch?.() ??
            new Error('Host is not owned by this process.'));
        return;
      }
    } catch (error) {
      if (
        error === mismatchError ||
        (options.retryResponseErrors === false && responseWasOk)
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.startupPoll));
  }
  throw new Error(options.timeoutMessage ?? 'Host startup timeout.');
}
