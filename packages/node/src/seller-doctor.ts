// Read-only preflight for the seller daemon: the checks `pnpm node:start` would fail on, without starting,
// spawning or writing anything. Results carry static codes only; the RPC URL, relay token, key contents and
// home location never leave this module. Network use is limited to loopback port probes.
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import {
  NODE_ENVIRONMENT,
  ollamaModelManifest,
  ROLE_FILES,
  ROLE_KEY_FILES,
  type HomeEnvironment,
} from '@gyblos/config';
import { MODEL } from '@gyblos/engine-ollama/model';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { assertPortFree } from '@gyblos/runtime';
import type { RelayConfigurationCode } from '@gyblos/transport-iroh/constants';
import {
  RelayConfigurationError,
  relayModeFromEnv,
} from '@gyblos/transport-iroh/relays';

import { modelTokenizer } from './artifacts';
import {
  DOCTOR_CHECKS,
  DOCTOR_CODES,
  DOCTOR_STATUS,
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_ISSUE_CODES,
  NODE_ERROR_CODES,
  type DoctorCheckName,
  type DoctorCode,
  type DoctorStatus,
  type NodeErrorCode,
} from './constants';
import { NodeError } from './errors';
import {
  assertOllamaModelsHome,
  assertRoleHome,
  assertTokenizerHome,
} from './home';
import { readNodeConfigFile, type NodeConfig } from './node-config';
import type { NodeConfigIssue } from './node-config-fields';
import type { SellerLimits } from './node-config-limits';
import { inspectSellerSequence } from './public-sequence';
import { loadRole, roleKeyFilesStatus } from './roles';
import { SERVED_ENGINE_PROBE, type FreeSellerOffer } from './seller-offer';
import {
  sellerBaseSettings,
  sellerSettings,
  type SellerBaseSettings,
} from './seller-settings';

export type DoctorResultCode =
  DoctorCode | NodeErrorCode | RelayConfigurationCode;
export interface DoctorCheck {
  check: DoctorCheckName;
  status: DoctorStatus;
  code: DoctorResultCode;
  // Zero-based gyblos.toml [[offers]] entry a config failure is about.
  offer?: number;
}
type Result = Omit<DoctorCheck, 'check'>;
export interface DoctorReport {
  checks: DoctorCheck[];
  configIssues: NodeConfigIssue[];
  seller: { nodeId: string; owner: string } | undefined;
  offer: FreeSellerOffer | undefined;
  publication: string | undefined;
  limits: SellerLimits | undefined;
}
export interface DoctorProbes {
  // True when nothing answers on the loopback URL, as startup requires.
  portFree?: (url: string) => Promise<boolean>;
  // Throws when the pinned tokenizer files are absent or do not match their hashes.
  tokenizer?: (environment: HomeEnvironment) => Promise<unknown>;
}
export interface DoctorOptions {
  environment: HomeEnvironment;
  cwd: string;
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

// Exactly seller startup's file choice: GYBLOS_CONFIG must exist; without ./gyblos.toml the settings fail
// with SELLER_OFFERS_MISSING, as startup does.
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
    const settings = sellerSettings(file, options.environment);
    return { issues: [], settings, base: settings, result: OK };
  } catch (error) {
    const result: Result = {
      ...fail(errorCode(error)),
      ...(error instanceof NodeError && error.offer !== undefined
        ? { offer: error.offer }
        : {}),
    };
    // An offer the daemon refuses still leaves transport and relays checkable.
    let base: SellerBaseSettings | undefined;
    try {
      base = sellerBaseSettings(file, options.environment);
    } catch {
      base = undefined;
    }
    return { issues: [], base, result };
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

// The seller signs only with the owner key and its node key.
const KEY_NAMES = [ROLE_KEY_FILES.owner, ROLE_FILES.nodeKey];

async function roleChecks(environment: HomeEnvironment) {
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
      KEY_NAMES,
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

// The only loopback port startup binds: its managed Ollama.
async function portsCheck(
  portFree: (url: string) => Promise<boolean>,
): Promise<Result> {
  return (await portFree(SERVED_ENGINE_PROBE))
    ? OK
    : fail(DOCTOR_CODES.PORT_IN_USE);
}

function relaysCheck(settings: SellerBaseSettings): Result {
  try {
    relayModeFromEnv(settings.relayEnvironment);
    return OK;
  } catch (error) {
    return fail(errorCode(error));
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
  add(DOCTOR_CHECKS.CONFIG, config.result);
  add(DOCTOR_CHECKS.HOME, await homeCheck(environment));
  const role = await roleChecks(environment);
  add(DOCTOR_CHECKS.ROLE, role.role);
  add(DOCTOR_CHECKS.KEYS, role.keys ?? notChecked);
  add(DOCTOR_CHECKS.SEQUENCE, role.sequence ?? notChecked);
  add(DOCTOR_CHECKS.TOKENIZER, await tokenizerCheck(options));
  add(DOCTOR_CHECKS.OLLAMA, await ollamaCheck(environment));
  add(DOCTOR_CHECKS.MODEL, await modelCheck(environment));
  add(
    DOCTOR_CHECKS.PORTS,
    await portsCheck(options.probes?.portFree ?? defaultPortFree),
  );
  add(
    DOCTOR_CHECKS.RELAYS,
    config.base ? relaysCheck(config.base) : notChecked,
  );
  return {
    checks,
    configIssues: config.issues,
    seller: role.seller,
    offer: config.settings?.offer,
    publication: config.settings?.publication?.baseUrl,
    limits: config.settings?.limits,
  };
}
