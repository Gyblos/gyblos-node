// `gyblos seller status`: whether this home's seller is running, what it serves and how much it answered,
// read from the background service, the daemon's status.json and its signed receipts. Read-only; with
// --online it also looks the NodeId up in the discovery index, sending only the model. Prints counts,
// codes, public identifiers and URL origins; never a prompt, a buyer, a key, the home location or a value
// from the environment.
import { resolve } from 'node:path';

import { NODE_ENVIRONMENT } from '@gyblos/config';
import { homeLayout } from '@gyblos/config/home';
import { fetchSellers } from '@gyblos/discovery-http';
import {
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_ISSUE_CODES,
  RECEIPT_STORAGE,
  SELLER_DAEMON_STATES,
} from '@gyblos/node/constants';
import { readNodeConfigFile } from '@gyblos/node/node-config';
import { resolveNodeConfig } from '@gyblos/node/node-config-resolve';
import { listReceipts } from '@gyblos/node/receipts';
import { loadRole } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { urlOrigin } from './cli-format';
import {
  EXIT,
  SERVICE_STATES,
  STATUS,
  STATUS_ERRORS,
  STATUS_RESULTS,
  type ServiceState,
  type StatusErrorCode,
  type StatusResult,
} from './constants';
import {
  receiptActivity,
  type ActivityWindow,
  type DaemonStatus,
} from './status';
import {
  defaultStatusSystem,
  readDaemonStatus,
  serviceState,
  type DaemonFile,
  type StatusSystem,
} from './status-system';

const COLUMN = 13;
const ROLE_HINT =
  'no usable seller role in this home; `pnpm gyblos doctor` explains why';
const INDEX_LOOKUP = {
  FOUND: 'found',
  ABSENT: 'absent',
  TRUNCATED: 'truncated',
} as const;

interface StatusOutput {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type HomeEnvironment = StatusOutput['env'];

const line = (label: string, value: string) =>
  `  ${label.padEnd(COLUMN)} ${value}\n`;
const iso = (time: number) =>
  new Date(time).toISOString().replace(/\.\d+Z$/, 'Z');

// node:start's choice: an explicit GYBLOS_CONFIG must be readable; only a missing ./gyblos.toml is optional.
async function discoverySettings(output: StatusOutput) {
  const explicit = output.env[NODE_ENVIRONMENT.config];
  const parsed = await readNodeConfigFile(
    resolve(output.cwd, explicit || NODE_CONFIG_FILENAME),
  );
  const missing =
    !parsed.ok &&
    parsed.issues.length === 1 &&
    parsed.issues[0]!.code === NODE_CONFIG_ISSUE_CODES.FILE_NOT_FOUND;
  if (!parsed.ok && (explicit || !missing)) return undefined;
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
async function lookUp(
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
      return INDEX_LOOKUP.FOUND;
    if (!result.next) return INDEX_LOOKUP.ABSENT;
    cursor = result.next;
  }
  return INDEX_LOOKUP.TRUNCATED;
}

// Every served model is looked up; one unreachable model does not hide a match on another.
async function indexListing(
  system: StatusSystem,
  baseUrl: string,
  models: ReadonlySet<string>,
  nodeId: string,
) {
  if (!models.size) return 'not looked up: no offer is serving yet';
  let unreachable = false;
  let truncated = false;
  for (const model of models) {
    try {
      const found = await lookUp(system, baseUrl, model, nodeId);
      if (found === INDEX_LOOKUP.FOUND) return 'listed in the index';
      if (found === INDEX_LOOKUP.TRUNCATED) truncated = true;
    } catch {
      unreachable = true;
    }
  }
  if (unreachable) return 'index unreachable';
  return truncated
    ? `not in the first ${STATUS.maxIndexPages * STATUS.indexPageSize} sellers of the index`
    : 'not found in the index';
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
  return `${listing}; ${await indexListing(system, discovery.url, models, nodeId)}`;
}

function windowLine({
  completed,
  failed,
  cancelled,
  outputTokens,
}: ActivityWindow) {
  return `${completed} completed, ${failed} failed, ${cancelled} cancelled; ${outputTokens} output tokens`;
}

async function activityLines(
  homeEnvironment: HomeEnvironment,
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
    line(
      `last ${RECEIPT_STORAGE.retentionMs / STATUS.dayMs} days`,
      windowLine(activity.week),
    ),
    line(
      'last request',
      activity.lastAt === undefined ? 'none' : iso(activity.lastAt),
    ),
    ...activity.codes.map(([code, count]) => line('code', `${code} x${count}`)),
  ].join('');
}

function daemonLine(daemon: DaemonFile) {
  if (daemon.kind === 'missing') return 'never started in this home';
  if (daemon.kind === 'unreadable') return 'status file unreadable';
  const { status } = daemon;
  const phase = status.phase ? ` (${status.phase})` : '';
  return `${status.state}${phase}, written ${iso(daemon.updatedAt)}`;
}

function result(
  service: ServiceState,
  status: DaemonStatus | undefined,
): StatusResult {
  if (service === SERVICE_STATES.INACTIVE) return STATUS_RESULTS.STOPPED;
  if (service === SERVICE_STATES.ACTIVE)
    return status?.state === SELLER_DAEMON_STATES.READY
      ? STATUS_RESULTS.RUNNING
      : STATUS_RESULTS.STARTING;
  return STATUS_RESULTS.NOT_CONFIRMED;
}

// The seller role of this home, or undefined after printing why there is none.
async function sellerIdentity(
  homeEnvironment: HomeEnvironment,
  output: StatusOutput,
) {
  const refuse = (code: StatusErrorCode) => {
    output.stderr(`${code}: ${ROLE_HINT}\n`);
    return undefined;
  };
  let identity: Awaited<ReturnType<typeof loadRole>>;
  try {
    identity = await loadRole(P2P_ROLES.SELLER, homeEnvironment);
  } catch (error) {
    return refuse(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? STATUS_ERRORS.ROLE_MISSING
        : STATUS_ERRORS.ROLE_UNREADABLE,
    );
  }
  return identity.role === P2P_ROLES.SELLER
    ? identity
    : refuse(STATUS_ERRORS.ROLE_NOT_SELLER);
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
    readDaemonStatus(homeEnvironment),
    discoverySettings(output),
  ]);
  const status = daemon.kind === 'read' ? daemon.status : undefined;
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
  output.stdout(
    `Activity, from signed receipts (at most ${RECEIPT_STORAGE.maxEntries} kept):\n`,
  );
  output.stdout(await activityLines(homeEnvironment, identity.nodeId, now));
  const verdict = result(service, status);
  output.stdout(`Result: ${verdict}\n`);
  if (verdict === STATUS_RESULTS.NOT_CONFIRMED)
    output.stdout(
      '  Without a service, status.json shows the last state written; a stopped seller may still read "ready".\n',
    );
  return verdict === STATUS_RESULTS.RUNNING ? EXIT.ok : EXIT.failure;
}
