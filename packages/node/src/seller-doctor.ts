// Read-only preflight for the seller daemon: the checks `pnpm node:start` would fail on, without starting,
// spawning or writing anything. Results carry static codes only; the RPC URL, relay token, key contents and
// home location never leave this module. Network use is limited to loopback port probes unless `online`.
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import {
  FILE_MODES,
  homeLayout,
  HOSTS,
  NODE_ENVIRONMENT,
  ROUTES,
  type HomeEnvironment,
} from '@gyblos/config';
import { MODEL } from '@gyblos/engine-ollama/model';
import { assertPortFree } from '@gyblos/runtime';
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
  type DoctorStatus,
} from './constants.js';
import { NodeError } from './errors.js';
import {
  assertOllamaModelsHome,
  assertRoleHome,
  assertTokenizerHome,
} from './home.js';
import type { NodeConfigIssue } from './node-config-fields.js';
import { readNodeConfigFile, type NodeConfig } from './node-config.js';
import { loadRole, publicRole } from './roles.js';
import type { SellerCatalogOffer } from './seller-offer.js';
import { sellerSettings, type SellerSettings } from './seller-settings.js';

export interface DoctorCheck {
  check: DoctorCheckName;
  status: DoctorStatus;
  code: string;
}
export interface DoctorReport {
  checks: DoctorCheck[];
  configPath: string | undefined;
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
}
export interface DoctorOptions {
  environment: HomeEnvironment;
  cwd: string;
  configPath?: string;
  online: boolean;
  probes?: DoctorProbes;
}

const errorCode = (error: unknown) =>
  error instanceof NodeError || error instanceof RelayConfigurationError
    ? error.code
    : DOCTOR_CODES.INTERNAL;

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

// Same file choice as seller startup: an explicit path must exist, the implicit one is optional.
async function configCheck(options: DoctorOptions) {
  const explicit =
    options.configPath ?? options.environment[NODE_ENVIRONMENT.config];
  const path = resolve(options.cwd, explicit || NODE_CONFIG_FILENAME);
  const read = await readNodeConfigFile(path);
  let file: NodeConfig | undefined;
  if (read.ok) file = read.config;
  else {
    const missing =
      read.issues.length === 1 &&
      read.issues[0]!.code === NODE_CONFIG_ISSUE_CODES.FILE_NOT_FOUND;
    if (!missing || explicit)
      return {
        path,
        issues: read.issues,
        result: {
          status: DOCTOR_STATUS.FAIL,
          code: NODE_ERROR_CODES.NODE_CONFIG_INVALID,
        },
      };
  }
  try {
    const settings = sellerSettings(file, options.environment, {
      freeExecution: true,
    });
    return {
      path: file ? path : undefined,
      issues: [],
      settings,
      result: {
        status: DOCTOR_STATUS.OK,
        code: file ? DOCTOR_CODES.READY : DOCTOR_CODES.NO_FILE,
      },
    };
  } catch (error) {
    return {
      path,
      issues: [],
      result: { status: DOCTOR_STATUS.FAIL, code: errorCode(error) },
    };
  }
}

async function homeCheck(environment: HomeEnvironment) {
  try {
    await assertRoleHome(P2P_ROLES.SELLER, environment);
    await assertOllamaModelsHome(environment);
    await assertTokenizerHome(environment);
    return { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
  } catch (error) {
    return { status: DOCTOR_STATUS.FAIL, code: errorCode(error) };
  }
}

async function roleChecks(environment: HomeEnvironment) {
  let config: Awaited<ReturnType<typeof loadRole>>;
  try {
    config = await loadRole(P2P_ROLES.SELLER, environment);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      role: {
        status: DOCTOR_STATUS.FAIL,
        code: missing ? DOCTOR_CODES.ROLE_MISSING : errorCode(error),
      },
    };
  }
  if (config.role !== P2P_ROLES.SELLER)
    return {
      role: { status: DOCTOR_STATUS.FAIL, code: DOCTOR_CODES.ROLE_NOT_SELLER },
    };
  const seller = { nodeId: config.nodeId, owner: config.owner };
  const role = { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
  // Only lstat: modes are read, key contents never are.
  let keys;
  try {
    const visible = await publicRole(P2P_ROLES.SELLER, environment);
    keys = visible.keys.every((key) => key.mode === FILE_MODES.privateFile)
      ? { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY }
      : { status: DOCTOR_STATUS.FAIL, code: DOCTOR_CODES.KEY_PERMISSIONS };
  } catch (error) {
    keys = {
      status: DOCTOR_STATUS.FAIL,
      code:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? DOCTOR_CODES.KEYS_MISSING
          : errorCode(error),
    };
  }
  return { role, keys, seller, rpcUrl: config.rpcUrl };
}

async function tokenizerCheck(environment: HomeEnvironment) {
  try {
    await modelTokenizer(environment);
    return { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
  } catch {
    return {
      status: DOCTOR_STATUS.FAIL,
      code: DOCTOR_CODES.TOKENIZER_UNAVAILABLE,
    };
  }
}

// Startup spawns `ollama` from PATH; look for it without running it.
async function ollamaCheck(environment: HomeEnvironment) {
  const names =
    process.platform === 'win32' ? ['ollama.exe', 'ollama'] : ['ollama'];
  for (const directory of (environment.PATH ?? '')
    .split(delimiter)
    .filter(Boolean))
    for (const name of names)
      try {
        await access(join(directory, name), constants.X_OK);
        return { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
      } catch {
        // Try the next PATH entry.
      }
  return { status: DOCTOR_STATUS.FAIL, code: DOCTOR_CODES.OLLAMA_NOT_FOUND };
}

// Ollama's own manifest layout; a warning, since only Ollama can confirm the model is usable.
async function modelCheck(environment: HomeEnvironment) {
  const [name, tag] = MODEL.name.split(':');
  try {
    await access(
      join(
        homeLayout(environment).artifacts.ollamaModels,
        'manifests',
        'registry.ollama.ai',
        'library',
        name!,
        tag!,
      ),
    );
    return { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
  } catch {
    return {
      status: DOCTOR_STATUS.WARN,
      code: DOCTOR_CODES.MODEL_NOT_DOWNLOADED,
    };
  }
}

async function portsCheck(
  free: boolean,
  portFree: (url: string) => Promise<boolean>,
) {
  const urls = [`${HOSTS.ollama}${ROUTES.ollamaVersion}`];
  if (!free) urls.push(`${HOSTS.facilitator}${ROUTES.health}`);
  for (const url of urls)
    if (!(await portFree(url)))
      return { status: DOCTOR_STATUS.FAIL, code: DOCTOR_CODES.PORT_IN_USE };
  return { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
}

function relaysCheck(settings: SellerSettings) {
  try {
    relayModeFromEnv(settings.relayEnvironment);
    return { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
  } catch (error) {
    return { status: DOCTOR_STATUS.FAIL, code: errorCode(error) };
  }
}

async function programCheck(
  options: DoctorOptions,
  free: boolean | undefined,
  rpcUrl: string | undefined,
) {
  if (free) return { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.NOT_NEEDED };
  if (free === undefined || rpcUrl === undefined)
    return { status: DOCTOR_STATUS.WARN, code: DOCTOR_CODES.NOT_CHECKED };
  if (!options.online)
    return {
      status: DOCTOR_STATUS.WARN,
      code: DOCTOR_CODES.ONLINE_CHECK_SKIPPED,
    };
  try {
    await (options.probes?.program ?? defaultProgram)(rpcUrl);
    return { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.READY };
  } catch {
    return {
      status: DOCTOR_STATUS.FAIL,
      code: DOCTOR_CODES.DEVNET_PROGRAM_UNAVAILABLE,
    };
  }
}

export async function sellerDoctor(
  options: DoctorOptions,
): Promise<DoctorReport> {
  const { environment } = options;
  const checks: DoctorCheck[] = [];
  const add = (
    check: DoctorCheckName,
    result: { status: DoctorStatus; code: string },
  ) => checks.push({ check, ...result });
  const config = await configCheck(options);
  add(DOCTOR_CHECKS.CONFIG, config.result);
  add(DOCTOR_CHECKS.HOME, await homeCheck(environment));
  const role = await roleChecks(environment);
  add(DOCTOR_CHECKS.ROLE, role.role);
  if (role.keys) add(DOCTOR_CHECKS.KEYS, role.keys);
  add(DOCTOR_CHECKS.TOKENIZER, await tokenizerCheck(environment));
  add(DOCTOR_CHECKS.OLLAMA, await ollamaCheck(environment));
  add(DOCTOR_CHECKS.MODEL, await modelCheck(environment));
  const free = config.settings
    ? config.settings.offer.kind === OFFER_PRICING_KINDS.FREE
    : undefined;
  add(
    DOCTOR_CHECKS.PORTS,
    await portsCheck(
      free ?? false,
      options.probes?.portFree ?? defaultPortFree,
    ),
  );
  add(
    DOCTOR_CHECKS.RELAYS,
    config.settings
      ? relaysCheck(config.settings)
      : { status: DOCTOR_STATUS.WARN, code: DOCTOR_CODES.NOT_CHECKED },
  );
  add(DOCTOR_CHECKS.PROGRAM, await programCheck(options, free, role.rpcUrl));
  return {
    checks,
    configPath: config.path,
    configIssues: config.issues,
    seller: role.seller,
    offer: config.settings?.offer,
    publication: config.settings?.publication?.baseUrl,
  };
}
