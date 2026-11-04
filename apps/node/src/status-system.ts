// What `gyblos seller status` reads outside its receipts: the service manager (asked with a fixed argv, no
// shell, a timeout and bounded output) and the daemon's status.json (opened without following a link,
// bounded, never a FIFO or device). Tests replace the service manager, the index and the clock.
import { spawn } from 'node:child_process';
import { constants, lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';

import { ROLE_FILES, rolePathIn } from '@gyblos/config/home';
import type { DiscoveryFetch } from '@gyblos/discovery-http';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import {
  EXIT,
  SERVICE,
  SERVICE_KINDS,
  SERVICE_STATES,
  STATUS,
  type ServiceState,
} from './constants';
import { serviceLocation } from './service';
import { parseDaemonStatus, type DaemonStatus } from './status';

export interface ProbeResult {
  code: number;
  output: string;
}

export interface StatusSystem {
  platform: NodeJS.Platform;
  uid: number | undefined;
  accountHome: string;
  // Runs a command without a shell and resolves its exit code and the start of its standard output.
  probe: (argv: readonly string[]) => Promise<ProbeResult>;
  fetch: DiscoveryFetch;
  now: () => number;
}

// The job's own state line, one tab deep, reads running only while its process is alive; nested sections
// (endpoints, sockets) carry their own deeper `state =` lines.
const LAUNCHD_RUNNING = /^\tstate = running$/m;
const READ_ONLY_FILE =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function probeCommand(argv: readonly string[]) {
  return new Promise<ProbeResult>((done) => {
    const [command, ...args] = argv;
    const child = spawn(command!, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: STATUS.probeTimeoutMs,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (output.length < STATUS.probeOutputCharacters) output += chunk;
    });
    child.on('error', () => done({ code: EXIT.failure, output: '' }));
    child.on('close', (code) => done({ code: code ?? EXIT.failure, output }));
  });
}

export function defaultStatusSystem(): StatusSystem {
  return {
    platform: process.platform,
    uid: process.getuid?.(),
    accountHome: homedir(),
    probe: probeCommand,
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
  };
}

async function installed(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// The unit or agent `gyblos seller service install` writes, and whether its process runs now.
export async function serviceState(
  system: StatusSystem,
): Promise<ServiceState> {
  const kind =
    system.platform === 'linux'
      ? SERVICE_KINDS.SYSTEMD_USER
      : system.platform === 'darwin'
        ? SERVICE_KINDS.LAUNCHD
        : undefined;
  if (!kind || system.uid === undefined || system.uid === 0)
    return SERVICE_STATES.UNKNOWN;
  try {
    if (
      !(await installed(
        serviceLocation(kind, system.accountHome, system.uid).path,
      ))
    )
      return SERVICE_STATES.NOT_INSTALLED;
  } catch {
    return SERVICE_STATES.UNKNOWN;
  }
  if (kind === SERVICE_KINDS.LAUNCHD) {
    const { code, output } = await system.probe([
      'launchctl',
      'print',
      `gui/${system.uid}/${SERVICE.label}`,
    ]);
    return code === EXIT.ok && LAUNCHD_RUNNING.test(output)
      ? SERVICE_STATES.ACTIVE
      : SERVICE_STATES.INACTIVE;
  }
  // is-active is non-zero while systemd waits to restart a failed seller.
  const { code } = await system.probe([
    'systemctl',
    '--user',
    'is-active',
    '--quiet',
    SERVICE.unit,
  ]);
  return code === EXIT.ok ? SERVICE_STATES.ACTIVE : SERVICE_STATES.INACTIVE;
}

export type DaemonFile =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'read'; status: DaemonStatus; updatedAt: number };

export async function readDaemonStatus(
  homeEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<DaemonFile> {
  const path = rolePathIn(homeEnvironment, P2P_ROLES.SELLER, ROLE_FILES.status);
  let file;
  try {
    file = await open(path, READ_ONLY_FILE);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > STATUS.statusFileBytes)
      return { kind: 'unreadable' };
    const bytes = Buffer.alloc(STATUS.statusFileBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > STATUS.statusFileBytes) return { kind: 'unreadable' };
    const status = parseDaemonStatus(
      bytes.subarray(0, bytesRead).toString('utf8'),
    );
    return status
      ? { kind: 'read', status, updatedAt: stats.mtimeMs }
      : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    // A failed close of a read-only handle changes nothing that was read.
    await file.close().catch(() => undefined);
  }
}
