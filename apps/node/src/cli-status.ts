// `gyblos seller status`: whether this home's seller is running, what it serves and how much it answered,
// read from the background service, the daemon's status.json and its signed receipts. Read-only; with
// --online it also looks the NodeId up in the discovery index, sending only the model. Prints counts,
// codes, public identifiers and URL origins; never a prompt, a buyer, a key, the home location or a value
// from the environment.
import { fetchSellers } from '@gyblos/discovery-http';
import { RECEIPT_STORAGE, SELLER_DAEMON_STATES } from '@gyblos/node/constants';
import { listReceipts } from '@gyblos/node/receipts';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { urlOrigin } from './cli-format';
import { codeHint } from './cli-hints';
import { LISTING, nextStep } from './cli-next';
import { updateNotice } from './cli-update';
import {
  EXIT,
  SERVICE_STATES,
  STATUS,
  STATUS_RESULTS,
  type ServiceState,
  type StatusResult,
} from './constants';
import {
  discoverySettings,
  homeEnvironmentOf,
  sellerIdentity,
  type SellerOutput,
} from './seller-home';
import {
  outputRate,
  receiptActivity,
  type ActivityWindow,
  type DaemonStatus,
} from './status';
import {
  defaultStatusSystem,
  inContainer,
  readDaemonStatus,
  serviceState,
  type DaemonFile,
  type StatusSystem,
} from './status-system';

const LISTED = 'listed in the index';
const NOT_FOUND = 'not found in the index';

const COLUMN = 13;
const INDEX_LOOKUP = {
  FOUND: 'found',
  ABSENT: 'absent',
  TRUNCATED: 'truncated',
} as const;

type StatusOutput = SellerOutput;
type HomeEnvironment = StatusOutput['env'];

const line = (label: string, value: string) =>
  `  ${label.padEnd(COLUMN)} ${value}\n`;
const iso = (time: number) =>
  new Date(time).toISOString().replace(/\.\d+Z$/, 'Z');

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
      if (found === INDEX_LOOKUP.FOUND) return LISTED;
      if (found === INDEX_LOOKUP.TRUNCATED) truncated = true;
    } catch {
      unreachable = true;
    }
  }
  if (unreachable) return 'index unreachable';
  return truncated
    ? `not in the first ${STATUS.maxIndexPages * STATUS.indexPageSize} sellers of the index`
    : NOT_FOUND;
}

async function discoveryLine(
  online: boolean,
  system: StatusSystem,
  discovery: Awaited<ReturnType<typeof discoverySettings>>,
  status: DaemonStatus | undefined,
  nodeId: string,
) {
  if (!discovery)
    return {
      text: 'configuration invalid; run `pnpm gyblos doctor`',
      listing: LISTING.UNKNOWN,
    };
  if (!discovery.publish) return { text: 'off', listing: LISTING.OFF };
  const on = `on (${urlOrigin(discovery.url)})`;
  if (!online) return { text: on, listing: LISTING.UNCHECKED };
  const models = new Set(
    (status?.offers ?? [])
      .filter((offer) => offer.listed)
      .map((offer) => offer.modelId),
  );
  const found = await indexListing(system, discovery.url, models, nodeId);
  return {
    text: `${on}; ${found}`,
    listing:
      found === LISTED
        ? LISTING.LISTED
        : found === NOT_FOUND
          ? LISTING.ABSENT
          : LISTING.UNKNOWN,
  };
}

function windowLine(window: ActivityWindow) {
  const { completed, failed, cancelled, outputTokens } = window;
  const rate = outputRate(window);
  const speed =
    rate === undefined ? '' : `; ~${rate.toFixed(1)} output tokens/s`;
  return `${completed} completed, ${failed} failed, ${cancelled} cancelled; ${outputTokens} output tokens${speed}`;
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
  const code = status.code ? `: ${status.code}` : '';
  return `${status.state}${phase}${code}, written ${iso(daemon.updatedAt)}`;
}

// The failure to explain: this status's own, or the previous start's while it restarts.
function failureOf(status: DaemonStatus | undefined) {
  if (status?.state === SELLER_DAEMON_STATES.FAILED)
    return { code: status.code, phase: status.phase };
  if (status?.state === SELLER_DAEMON_STATES.STARTING)
    return status.lastFailure;
  return undefined;
}

function result(
  service: ServiceState,
  status: DaemonStatus | undefined,
): StatusResult {
  if (service === SERVICE_STATES.INACTIVE) return STATUS_RESULTS.STOPPED;
  if (failureOf(status)) return STATUS_RESULTS.FAILING;
  if (service === SERVICE_STATES.ACTIVE)
    return status?.state === SELLER_DAEMON_STATES.READY
      ? STATUS_RESULTS.RUNNING
      : STATUS_RESULTS.STARTING;
  return STATUS_RESULTS.NOT_CONFIRMED;
}

export async function statusCommand(
  options: { online: boolean },
  output: StatusOutput,
  system: StatusSystem = defaultStatusSystem(),
) {
  const homeEnvironment = homeEnvironmentOf(output);
  const identity = await sellerIdentity(homeEnvironment, output);
  if (!identity) return EXIT.failure;
  const now = system.now();
  // Started first so the request overlaps the local reads.
  const update = updateNotice(
    output.env,
    system.fetch,
    inContainer(output.env),
  );
  const [service, daemon, discovery] = await Promise.all([
    serviceState(system, output.env),
    readDaemonStatus(homeEnvironment),
    discoverySettings(output),
  ]);
  const status = daemon.kind === 'read' ? daemon.status : undefined;
  output.stdout(`Seller ${identity.nodeId}\n`);
  output.stdout(line('owner', identity.owner));
  output.stdout(
    line(
      'service',
      inContainer(output.env) ? `${service} (container)` : service,
    ),
  );
  output.stdout(line('daemon', daemonLine(daemon)));
  for (const offer of status?.offers ?? [])
    output.stdout(
      line(
        'offer',
        `${offer.modelId} via ${offer.engine}: ${offer.listed ? 'serving' : 'not serving yet'}`,
      ),
    );
  const listing = await discoveryLine(
    options.online,
    system,
    discovery,
    status,
    identity.nodeId,
  );
  output.stdout(line('discovery', listing.text));
  output.stdout(
    `Activity, from signed receipts (at most ${RECEIPT_STORAGE.maxEntries} kept):\n`,
  );
  output.stdout(await activityLines(homeEnvironment, identity.nodeId, now));
  const verdict = result(service, status);
  output.stdout(`Result: ${verdict}\n`);
  const failure = failureOf(status);
  if (verdict === STATUS_RESULTS.FAILING && failure) {
    const where = failure.phase ? ` at ${failure.phase}` : '';
    const code = failure.code ?? 'no static code; see the daemon log';
    const help = failure.code ? codeHint(failure.code) : '';
    output.stdout(
      `  The last start failed${where}: ${code}${help ? ` (${help})` : ''}\n`,
    );
  }
  if (verdict === STATUS_RESULTS.RUNNING) {
    const next = nextStep(
      listing.listing,
      identity.owner,
      inContainer(output.env),
    );
    if (listing.listing === LISTING.LISTED)
      output.stdout('Selling: buyers can find this seller in the index.\n');
    else if (next) output.stdout(`Next: ${next}\n`);
  }
  if (verdict === STATUS_RESULTS.NOT_CONFIRMED)
    output.stdout(
      '  Without a service, status.json shows the last state written; a stopped seller may still read "ready".\n',
    );
  const available = await update;
  if (available) output.stdout(`Update: ${available}\n`);
  return verdict === STATUS_RESULTS.RUNNING ? EXIT.ok : EXIT.failure;
}
