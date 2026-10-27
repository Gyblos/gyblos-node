// Read-only preflight for the seller daemon: the checks `pnpm node:start` would fail on, without starting,
// spawning or writing anything. Results carry static codes only; the RPC URL, relay token, key contents and
// home location never leave this module. Network use is limited to loopback port probes unless `online`.
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import {
  HOSTS,
  LOCALHOST,
  NODE_ENVIRONMENT,
  ollamaModelManifest,
  PORTS,
  ROLE_FILES,
  ROLE_KEY_FILES,
  ROUTES,
  type HomeEnvironment,
} from '@gyblos/config';
import { MODEL } from '@gyblos/engine-ollama/model';
import { assertPortFree } from '@gyblos/runtime';
import type { RelayConfigurationCode } from '@gyblos/transport-iroh/constants';
import {
  RelayConfigurationError,
  relayModeFromEnv,
} from '@gyblos/transport-iroh/relays';

import { modelTokenizer } from './artifacts.js';
import {
  DOCTOR_CHECKS,
  DOCTOR_CODES,
  DOCTOR_STATUS,
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_ISSUE_CODES,
  NODE_ERROR_CODES,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
  type DoctorCheckName,
  type DoctorCode,
  type DoctorStatus,
  type NodeErrorCode,
} from './constants.js';
import { NodeError } from './errors.js';
import {
  assertOllamaModelsHome,
  assertRoleHome,
  assertTokenizerHome,
} from './home.js';
import type { NodeConfigIssue } from './node-config-fields.js';
import { readNodeConfigFile, type NodeConfig } from './node-config.js';
import { inspectSellerSequence } from './public-sequence.js';
import { loadRole, roleKeyFilesStatus } from './roles.js';
import type { SellerCatalogOffer } from './seller-offer.js';
import { sellerSettings, type SellerSettings } from './seller-settings.js';

export type DoctorResultCode =
  DoctorCode | NodeErrorCode | RelayConfigurationCode;
export interface DoctorCheck {
  check: DoctorCheckName;
  status: DoctorStatus;
  code: DoctorResultCode;
}
type Result = Omit<DoctorCheck, 'check'>;
export interface DoctorReport {
  checks: DoctorCheck[];
  configIssues: NodeConfigIssue[];
  seller: { nodeId: string; owner: string } | undefined;
  offer: SellerCatalogOffer | undefined;
  publication: string | undefined;
}
export interface DoctorProbes {
  // True when nothing answers on the loopback URL, as startup requires.
  portFree?: (url: string) => Promise<boolean>;
  // Throws when the devnet payment program is unusable; only called with `online` for a paid offer.
  program?: (rpcUrl: string) => Promise<void>;
  // Throws when the pinned tokenizer files are absent or do not match their hashes.
  tokenizer?: (environment: HomeEnvironment) => Promise<unknown>;
}
export interface DoctorOptions {
  environment: HomeEnvironment;
  cwd: string;
  online: boolean;
  probes?: DoctorProbes;
}

const OK: Result = { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
const fail = (code: DoctorResultCode): Result => ({
  status: DOCTOR_STATUS.FAIL,
  code,
});
const warn = (code: DoctorResultCode): Result => ({
  status: DOCTOR_STATUS.WARN,
  code,
});
const errorCode = (error: unknown): DoctorResultCode =>
  error instanceof NodeError || error instanceof RelayConfigurationError
    ? error.code
    : DOCTOR_CODES.CHECK_FAILED;

async function defaultPortFree(url: string) {
  try {
    await assertPortFree(url);
    return true;
  } catch {
    return false;
  }
}

async function defaultProgram(rpcUrl: string) {
  // Loaded only for --online so the offline doctor never pulls in the payment client.
  const { assertProgram } = await import('@gyblos/payments-x402/chain');
  await assertProgram(rpcUrl);
}

// Exactly seller startup's file choice: GYBLOS_CONFIG must exist; the implicit ./gyblos.toml is optional.
async function configCheck(options: DoctorOptions) {
  const explicit = options.environment[NODE_ENVIRONMENT.config];
  const read = await readNodeConfigFile(
    resolve(options.cwd, explicit || NODE_CONFIG_FILENAME),
  );
  let file: NodeConfig | undefined;
  if (read.ok) file = read.config;
  else {
    const missing =
      read.issues.length === 1 &&
      read.issues[0]!.code === NODE_CONFIG_ISSUE_CODES.FILE_NOT_FOUND;
    if (!missing || explicit)
      return {
        issues: read.issues,
        result: fail(NODE_ERROR_CODES.NODE_CONFIG_INVALID),
      };
  }
  try {
    const settings = sellerSettings(file, options.environment, {
      freeExecution: true,
    });
    return {
      issues: [],
      settings,
      result: file ? OK : { ...OK, code: DOCTOR_CODES.NO_CONFIG_FILE },
    };
  } catch (error) {
    return { issues: [], result: fail(errorCode(error)) };
  }
}

async function homeCheck(environment: HomeEnvironment): Promise<Result> {
  try {
    await assertRoleHome(P2P_ROLES.SELLER, environment);
    await assertOllamaModelsHome(environment);
    await assertTokenizerHome(environment);
    return OK;
  } catch (error) {
    return fail(errorCode(error));
  }
}

// Free sellers sign only with the owner key; paid ones also load the authorizer and facilitator.
function keyNames(free: boolean | undefined) {
  return [
    ROLE_KEY_FILES.owner,
    ...(free ? [] : [ROLE_KEY_FILES.authorizer, ROLE_KEY_FILES.facilitator]),
    ROLE_FILES.nodeKey,
  ];
}

async function roleChecks(
  environment: HomeEnvironment,
  free: boolean | undefined,
) {
  let config: Awaited<ReturnType<typeof loadRole>>;
  try {
    config = await loadRole(P2P_ROLES.SELLER, environment);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      role: fail(missing ? DOCTOR_CODES.ROLE_MISSING : errorCode(error)),
    };
  }
  if (config.role !== P2P_ROLES.SELLER)
    return { role: fail(DOCTOR_CODES.ROLE_NOT_SELLER) };
  // Metadata only: key contents are never read.
  let keys: Result;
  try {
    const status = await roleKeyFilesStatus(
      P2P_ROLES.SELLER,
      keyNames(free),
      environment,
    );
    keys =
      status === 'ok'
        ? OK
        : fail(
            status === 'missing'
              ? DOCTOR_CODES.KEYS_MISSING
              : DOCTOR_CODES.KEY_PERMISSIONS,
          );
  } catch (error) {
    keys = fail(errorCode(error));
  }
  let sequence: Result;
  try {
    const inspected = await inspectSellerSequence({
      environment,
      nodeId: config.nodeId,
    });
    // Every sequence allocation takes this lock exclusively, so a leftover one blocks all publishing.
    sequence = inspected.lockPresent
      ? fail(DOCTOR_CODES.SEQUENCE_LOCK_PRESENT)
      : OK;
  } catch (error) {
    sequence = fail(errorCode(error));
  }
  return {
    role: OK,
    keys,
    sequence,
    seller: { nodeId: config.nodeId, owner: config.owner },
    rpcUrl: config.rpcUrl,
  };
}

async function tokenizerCheck(options: DoctorOptions): Promise<Result> {
  try {
    await (options.probes?.tokenizer ?? modelTokenizer)(options.environment);
    return OK;
  } catch {
    return fail(DOCTOR_CODES.TOKENIZER_UNAVAILABLE);
  }
}

// Startup spawns `ollama` from PATH; look for an executable file without running it.
async function ollamaCheck(environment: HomeEnvironment): Promise<Result> {
  const names =
    process.platform === 'win32' ? ['ollama.exe', 'ollama'] : ['ollama'];
  const directories = (environment.PATH ?? '').split(delimiter).filter(Boolean);
  for (const directory of directories)
    for (const name of names) {
      const path = join(directory, name);
      try {
        await access(path, constants.X_OK);
        if ((await stat(path)).isFile()) return OK;
      } catch {
        // Try the next PATH entry.
      }
    }
  return fail(DOCTOR_CODES.OLLAMA_NOT_FOUND);
}

// Startup points Ollama at this directory and never pulls, so an absent manifest fails warmup.
async function modelCheck(environment: HomeEnvironment): Promise<Result> {
  const [name, tag] = MODEL.name.split(':');
  try {
    await access(ollamaModelManifest(environment, name!, tag!));
    return OK;
  } catch {
    return fail(DOCTOR_CODES.MODEL_NOT_DOWNLOADED);
  }
}

// The loopback ports startup binds: Ollama always; the facilitator and the paid HTTP seller when paid.
export function sellerPorts(free: boolean) {
  return free
    ? [PORTS.ollama]
    : [PORTS.ollama, PORTS.facilitator, PORTS.seller];
}
const PROBE_URLS: Readonly<Record<number, string>> = {
  [PORTS.ollama]: `${HOSTS.ollama}${ROUTES.ollamaVersion}`,
  [PORTS.facilitator]: `${HOSTS.facilitator}${ROUTES.health}`,
  [PORTS.seller]: `http://${LOCALHOST}:${PORTS.seller}${ROUTES.health}`,
};

async function portsCheck(
  free: boolean,
  portFree: (url: string) => Promise<boolean>,
): Promise<Result> {
  for (const port of sellerPorts(free))
    if (!(await portFree(PROBE_URLS[port]!)))
      return fail(DOCTOR_CODES.PORT_IN_USE);
  return OK;
}

function relaysCheck(settings: SellerSettings): Result {
  try {
    relayModeFromEnv(settings.relayEnvironment);
    return OK;
  } catch (error) {
    return fail(errorCode(error));
  }
}

async function programCheck(
  options: DoctorOptions,
  free: boolean,
  rpcUrl: string | undefined,
): Promise<Result> {
  if (free) return { ...OK, code: DOCTOR_CODES.NOT_NEEDED };
  if (rpcUrl === undefined) return warn(DOCTOR_CODES.NOT_CHECKED);
  if (!options.online) return warn(DOCTOR_CODES.ONLINE_CHECK_SKIPPED);
  try {
    await (options.probes?.program ?? defaultProgram)(rpcUrl);
    return OK;
  } catch {
    return fail(DOCTOR_CODES.DEVNET_PROGRAM_UNAVAILABLE);
  }
}

export async function sellerDoctor(
  options: DoctorOptions,
): Promise<DoctorReport> {
  const { environment } = options;
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheckName, result: Result) =>
    checks.push({ check, ...result });
  const notChecked = warn(DOCTOR_CODES.NOT_CHECKED);
  const config = await configCheck(options);
  const free = config.settings
    ? config.settings.offer.kind === OFFER_PRICING_KINDS.FREE
    : undefined;
  add(DOCTOR_CHECKS.CONFIG, config.result);
  add(DOCTOR_CHECKS.HOME, await homeCheck(environment));
  const role = await roleChecks(environment, free);
  add(DOCTOR_CHECKS.ROLE, role.role);
  add(DOCTOR_CHECKS.KEYS, role.keys ?? notChecked);
  add(DOCTOR_CHECKS.SEQUENCE, role.sequence ?? notChecked);
  add(DOCTOR_CHECKS.TOKENIZER, await tokenizerCheck(options));
  add(DOCTOR_CHECKS.OLLAMA, await ollamaCheck(environment));
  add(DOCTOR_CHECKS.MODEL, await modelCheck(environment));
  add(
    DOCTOR_CHECKS.PORTS,
    free === undefined
      ? notChecked
      : await portsCheck(free, options.probes?.portFree ?? defaultPortFree),
  );
  add(
    DOCTOR_CHECKS.RELAYS,
    config.settings ? relaysCheck(config.settings) : notChecked,
  );
  add(
    DOCTOR_CHECKS.PROGRAM,
    free === undefined
      ? notChecked
      : await programCheck(options, free, role.rpcUrl),
  );
  return {
    checks,
    configIssues: config.issues,
    seller: role.seller,
    offer: config.settings?.offer,
    publication: config.settings?.publication?.baseUrl,
  };
}
