// Runs real CLI lifetimes with synthetic hosts, or the shared signal helper, in isolated children.
// Only disposable state and controlled signals are used; product startup/network/payment adapters are replaced.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPOSITORY_ROOT } from './node-config-fixtures';

export const SHUTDOWN_PROBE_ENTRIES = {
  HELPER: 'helper',
  SELLER: 'seller',
  BUYER: 'buyer',
} as const;
export type ShutdownProbeEntry =
  (typeof SHUTDOWN_PROBE_ENTRIES)[keyof typeof SHUTDOWN_PROBE_ENTRIES];
export interface ShutdownProbeOptions {
  entry: ShutdownProbeEntry;
  closedStderr?: boolean;
  throwingNotice?: boolean;
  rejectStop?: boolean;
  repeatSignal?: NodeJS.Signals;
}
function childSource(options: ShutdownProbeOptions) {
  const stop = String.raw`
    async function stop() {
      process.stdout.write('stopping\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      if (${Boolean(options.rejectStop)}) throw new Error('Synthetic stop failure');
    }
  `;
  const host =
    options.entry === SHUTDOWN_PROBE_ENTRIES.SELLER
      ? `${stop} export function createNode() { return { start: async () => {}, stop }; }`
      : `${stop} export class FreeBuyerStartupError extends Error {}
       export async function startFreeBuyer() { return { close: stop }; }`;
  const hostUrl = 'data:text/javascript,' + encodeURIComponent(host);
  const relaysUrl =
    'data:text/javascript,' +
    encodeURIComponent('export class RelayConfigurationError extends Error {}');
  const resolver = `
    export function resolve(specifier, context, next) {
      if (specifier === '@gyblos/node' ||
          (specifier === './free-startup' && context.parentURL?.endsWith('/apps/buyer/src/free-main.ts')))
        return { url: ${JSON.stringify(hostUrl)}, shortCircuit: true };
      if (specifier === '@gyblos/transport-iroh/relays')
        return { url: ${JSON.stringify(relaysUrl)}, shortCircuit: true };
      return next(specifier, context);
    }
  `;
  const resolverUrl = 'data:text/javascript,' + encodeURIComponent(resolver);
  const entry =
    options.entry === SHUTDOWN_PROBE_ENTRIES.SELLER
      ? '@gyblos/node-app/daemon'
      : '@gyblos/buyer/free-main';
  const invoke =
    options.entry === SHUTDOWN_PROBE_ENTRIES.HELPER
      ? `
      ${stop}
      const { shutdownSignal } = await import('@gyblos/runtime');
      const shutdown = shutdownSignal(${options.throwingNotice ? "() => { throw new Error('Synthetic notice failure'); }" : 'undefined'});
      const task = (async () => {
        try { await shutdown.signalled; await stop(); }
        finally { shutdown.dispose(); }
      })();
    `
      : `
      const { register } = await import('node:module');
      register(${JSON.stringify(resolverUrl)});
      const { main } = await import(${JSON.stringify(entry)});
      const task = main();
    `;
  // Test observers acknowledge signals but require the separate production guards to remain.
  // Removing entry wiring must still fail even though these observers keep a signal listener.
  return String.raw`
    const signals = ['SIGINT', 'SIGTERM'];
    const before = signals.map(signal => process.listenerCount(signal));
    let receivedSignals = 0;
    const observe = () => {
      if (++receivedSignals === 1) return;
      if (signals.some((signal, index) => process.listenerCount(signal) <= before[index] + 1))
        throw new Error('Production shutdown guard was removed before cleanup');
      process.stdout.write('repeated\n');
    };
    for (const signal of signals) process.on(signal, observe);
    const alive = setInterval(() => {}, 1000);
    let rejected = false;
    ${invoke}
    const settled = task.catch(() => { rejected = true; process.exitCode = 1; });
    while (process.listenerCount('SIGINT') === before[0] + 1)
      await new Promise(resolve => setImmediate(resolve));
    process.stdout.write('ready\n');
    try {
      await settled;
      const listeners = signals.map((signal, index) => process.listenerCount(signal) - before[index] - 1);
      process.stdout.write(JSON.stringify({ completed: true, rejected, listeners }) + '\n');
    } finally {
      for (const signal of signals) process.removeListener(signal, observe);
      clearInterval(alive);
    }
  `;
}

export async function shutdownProbe(options: ShutdownProbeOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-shutdown-probe-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childSource(options)],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        GYBLOS_HOME: join(directory, 'product'),
        GYBLOS_LAB_HOME: join(directory, 'lab'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let stderr = '';
  let first = false;
  let repeated = false;
  let released = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    if (!first && output.includes('ready')) {
      first = true;
      if (options.closedStderr) child.stderr.destroy();
      child.kill('SIGINT');
    }
    if (!repeated && output.includes('stopping')) {
      repeated = true;
      child.kill(options.repeatSignal ?? 'SIGINT');
    }
    if (!released && output.includes('repeated')) {
      released = true;
      child.stdin.end('release\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const status = await exited;
    return { ...status, output, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}
