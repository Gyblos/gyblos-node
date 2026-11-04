// `gyblos seller status`: whether this home's seller is running, what it serves and how much it answered,
// read from the background service, the daemon's status.json and its signed receipts. Read-only; with
// --online it also looks the NodeId up in the discovery index. Prints counts, codes, public identifiers and
// URL origins; never a prompt, a buyer, a key, the home location or a value from the environment.
import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { homeLayout, ROLE_FILES, rolePathIn } from '@gyblos/config/home';
import { fetchSellers, type DiscoveryFetch } from '@gyblos/discovery-http';
import { NODE_CONFIG_FILENAME } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import { readNodeConfigFile } from '@gyblos/node/node-config';
import { resolveNodeConfig } from '@gyblos/node/node-config-resolve';
import { listReceipts } from '@gyblos/node/receipts';
import { loadRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { urlOrigin } from './cli-format';
import {
  EXIT,
  SERVICE,
  SERVICE_KINDS,
  STATUS,
  STATUS_ERRORS,
  STATUS_RESULTS,
  type StatusResult,
} from './constants';
import { serviceLocation } from './service';
import {
  parseDaemonStatus,
  receiptActivity,
  type ActivityWindow,
  type DaemonStatus,
} from './status';

const COLUMN = 13;
const READY = 'ready';
const ROLE_HINT =
  'no usable seller role in this home; `pnpm gyblos doctor` explains why';

// Everything outside this home that status asks about; tests replace it.
export interface StatusSystem {
  platform: NodeJS.Platform;
  uid: number | undefined;
  accountHome: string;
  // Runs a command silently and resolves its exit code.
  probe: (argv: readonly string[]) => Promise<number>;
  fetch: DiscoveryFetch;
  now: () => number;
}

interface StatusOutput {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type ServiceState = 'active' | 'inactive' | 'not installed' | 'unknown';

function probeCommand(argv: readonly string[]) {
  return new Promise<number>((done) => {
    const [command, ...args] = argv;
    const child = spawn(command!, args, { stdio: 'ignore' });
    child.on('error', () => done(EXIT.failure));
    child.on('close', (code) => done(code ?? EXIT.failure));
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

const line = (label: string, value: string) =>
  `  ${label.padEnd(COLUMN)} ${value}\n`;

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// The unit or agent `gyblos seller service install` writes; launchd reports a loaded agent, not a process.
async function serviceState(system: StatusSystem): Promise<ServiceState> {
  const kind =
    system.platform === 'linux'
      ? SERVICE_KINDS.SYSTEMD_USER
      : system.platform === 'darwin'
        ? SERVICE_KINDS.LAUNCHD
        : undefined;
  if (!kind || system.uid === undefined || system.uid === 0) return 'unknown';
  if (
    !(await exists(serviceLocation(kind, system.accountHome, system.uid).path))
  )
    return 'not installed';
  const argv =
    kind === SERVICE_KINDS.LAUNCHD
      ? ['launchctl', 'print', `gui/${system.uid}/${SERVICE.label}`]
      : ['systemctl', '--user', 'is-active', '--quiet', SERVICE.unit];
  return (await system.probe(argv)) === EXIT.ok ? 'active' : 'inactive';
}

async function daemonStatus(homeEnvironment: StatusOutput['env']) {
  const path = rolePathIn(homeEnvironment, P2P_ROLES.SELLER, ROLE_FILES.status);
  try {
    const [text, stats] = await Promise.all([
      readFile(path, 'utf8'),
      lstat(path),
    ]);
    return { status: parseDaemonStatus(text), updatedAt: stats.mtimeMs };
  } catch {
    return undefined;
  }
}

async function discoverySettings(output: StatusOutput) {
  const parsed = await readNodeConfigFile(
    resolve(output.cwd, output.env.GYBLOS_CONFIG || NODE_CONFIG_FILENAME),
  );
  const resolved = resolveNodeConfig({
    file: parsed.ok ? parsed.config : undefined,
    env: output.env,
  });
  return resolved.ok
    ? {
        publish: resolved.settings.discoveryPublish,
        url: resolved.settings.discoveryUrl,
      }
    : undefined;
}

// Pages the index for one model until the NodeId shows up, the pages run out or the page budget is spent.
async function listedInIndex(
  system: StatusSystem,
  baseUrl: string,
  model: string,
  nodeId: string,
) {
  let cursor: string | undefined;
  for (let page = 0; page < STATUS.maxIndexPages; page++) {
    const result = await fetchSellers({
      baseUrl,
      model,
      fetch: system.fetch,
      now: system.now,
      timeoutMs: STATUS.indexTimeoutMs,
      limit: STATUS.indexPageSize,
      cursor,
    });
    if (result.sellers.some((entry) => entry.catalog.nodeId === nodeId))
      return true;
    if (!result.next) return false;
    cursor = result.next;
  }
  return false;
}

function windowLine({
  completed,
  failed,
  cancelled,
  outputTokens,
}: ActivityWindow) {
  return `${completed} completed, ${failed} failed, ${cancelled} cancelled; ${outputTokens} output tokens`;
}

function result(
  service: ServiceState,
  status: DaemonStatus | undefined,
): StatusResult {
  if (service === 'inactive') return STATUS_RESULTS.STOPPED;
  if (service === 'active')
    return status?.state === READY
      ? STATUS_RESULTS.RUNNING
      : STATUS_RESULTS.STARTING;
  return STATUS_RESULTS.NOT_CONFIRMED;
}

const iso = (time: number) =>
  new Date(time).toISOString().replace(/\.\d+Z$/, 'Z');

async function activityLines(
  homeEnvironment: StatusOutput['env'],
  nodeId: string,
  now: number,
) {
  let entries;
  try {
    entries = await listReceipts({
      environment: homeEnvironment,
      role: P2P_ROLES.SELLER,
      nodeId,
      now: () => now,
    });
  } catch {
    return line(
      'receipts',
      'unavailable (corrupt, locked or unsafe receipt file)',
    );
  }
  const activity = receiptActivity(entries, now);
  return [
    line('last 24h', windowLine(activity.day)),
    line('last 7 days', windowLine(activity.week)),
    line(
      'last request',
      activity.lastAt === undefined ? 'none' : iso(activity.lastAt),
    ),
    ...activity.codes.map(([code, count]) => line('code', `${code} x${count}`)),
  ].join('');
}

// The seller role of this home, or undefined after printing why there is none.
async function sellerIdentity(
  homeEnvironment: StatusOutput['env'],
  output: StatusOutput,
) {
  let identity: Awaited<ReturnType<typeof loadRole>>;
  try {
    identity = await loadRole(P2P_ROLES.SELLER, homeEnvironment);
  } catch (error) {
    const code =
      error instanceof NodeError
        ? error.code
        : (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? STATUS_ERRORS.ROLE_MISSING
          : STATUS_ERRORS.ROLE_UNREADABLE;
    output.stderr(`${code}: ${ROLE_HINT}\n`);
    return undefined;
  }
  if (identity.role === P2P_ROLES.SELLER) return identity;
  output.stderr(`${STATUS_ERRORS.ROLE_NOT_SELLER}: ${ROLE_HINT}\n`);
  return undefined;
}

async function discoveryLine(
  online: boolean,
  system: StatusSystem,
  discovery: Awaited<ReturnType<typeof discoverySettings>>,
  status: DaemonStatus | undefined,
  nodeId: string,
) {
  if (!discovery) return 'configuration invalid; run `pnpm gyblos doctor`';
  if (!discovery.publish) return 'off';
  const listing = `on (${urlOrigin(discovery.url)})`;
  if (!online) return listing;
  const models = new Set(
    (status?.offers ?? [])
      .filter((offer) => offer.listed)
      .map((offer) => offer.modelId),
  );
  try {
    for (const model of models)
      if (await listedInIndex(system, discovery.url, model, nodeId))
        return `${listing}; listed in the index`;
    return `${listing}; not found in the index`;
  } catch {
    return `${listing}; index unreachable`;
  }
}

function daemonLine(daemon: Awaited<ReturnType<typeof daemonStatus>>) {
  if (!daemon) return 'never started in this home';
  const { status } = daemon;
  if (!status) return 'status file unreadable';
  const phase = status.phase ? ` (${status.phase})` : '';
  return `${status.state}${phase}, written ${iso(daemon.updatedAt)}`;
}

export async function statusCommand(
  options: { online: boolean },
  output: StatusOutput,
  system: StatusSystem = defaultStatusSystem(),
) {
  // A relative GYBLOS_HOME is the working directory's, as for node:start.
  const homeEnvironment = {
    ...output.env,
    GYBLOS_HOME: resolve(output.cwd, homeLayout(output.env).root),
  };
  const identity = await sellerIdentity(homeEnvironment, output);
  if (!identity) return EXIT.failure;
  const now = system.now();
  const [service, daemon, discovery] = await Promise.all([
    serviceState(system),
    daemonStatus(homeEnvironment),
    discoverySettings(output),
  ]);
  const status = daemon?.status;
  output.stdout(`Seller ${identity.nodeId}\n`);
  output.stdout(line('owner', identity.owner));
  output.stdout(line('service', service));
  output.stdout(line('daemon', daemonLine(daemon)));
  for (const offer of status?.offers ?? [])
    output.stdout(
      line(
        'offer',
        `${offer.modelId} via ${offer.engine}: ${offer.listed ? 'serving' : 'not serving yet'}`,
      ),
    );
  output.stdout(
    line(
      'discovery',
      await discoveryLine(
        options.online,
        system,
        discovery,
        status,
        identity.nodeId,
      ),
    ),
  );
  output.stdout('Activity, from signed receipts (7 days, at most 256 kept):\n');
  output.stdout(await activityLines(homeEnvironment, identity.nodeId, now));
  const verdict = result(service, status);
  output.stdout(`Result: ${verdict}\n`);
  if (verdict === STATUS_RESULTS.NOT_CONFIRMED)
    output.stdout(
      '  Without a service, status.json shows the last state written; a stopped seller may still read "ready".\n',
    );
  return verdict === STATUS_RESULTS.RUNNING ? EXIT.ok : EXIT.failure;
}
