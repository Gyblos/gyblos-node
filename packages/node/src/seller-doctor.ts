// Read-only preflight for the seller daemon: the checks `pnpm node:start` would fail on, without starting,
// spawning or writing anything. Results carry static codes only; the RPC URL, relay token, key contents and
// home location never leave this module. Network use is limited to describing the offer's loopback engine.
import { resolve } from 'node:path';

import {
  NODE_ENVIRONMENT,
  ROLE_FILES,
  ROLE_KEY_FILES,
  type HomeEnvironment,
} from '@gyblos/config';
import {
  ENGINE_ERROR_CODES,
  P2P_ROLES,
  type EngineErrorCode,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import type { RelayConfigurationCode } from '@gyblos/transport-iroh/constants';
import {
  RelayConfigurationError,
  relayModeFromEnv,
} from '@gyblos/transport-iroh/relays';

import { modelTokenizer } from './artifacts';
import {
  DOCTOR_CHECKS,
  DOCTOR_CODES,
  DOCTOR_ENGINE_TIMEOUT_MS,
  DOCTOR_STATUS,
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_ISSUE_CODES,
  NODE_ERROR_CODES,
  type DoctorCheckName,
  type DoctorCode,
  type DoctorStatus,
  type NodeErrorCode,
} from './constants';
import { createSellerEngine } from './engine-registry';
import { NodeError } from './errors';
import { assertRoleHome, assertTokenizerHome } from './home';
import { readNodeConfigFile, type NodeConfig } from './node-config';
import type { NodeConfigIssue } from './node-config-fields';
import type { SellerLimits } from './node-config-limits';
import { inspectSellerSequence } from './public-sequence';
import { loadRole, roleKeyFilesStatus } from './roles';
import type { FreeSellerOffer } from './seller-offer';
import {
  sellerBaseSettings,
  sellerSettings,
  type SellerBaseSettings,
  type SellerSettings,
} from './seller-settings';

export type DoctorResultCode =
  DoctorCode | NodeErrorCode | RelayConfigurationCode | EngineErrorCode;
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
  // The engine's network path; tests point it nowhere else.
  fetch?: typeof fetch;
  engineTimeoutMs?: number;
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

// Describes the offer's engine the way warmup starts: for Ollama, the model list and pinned digest at the
// offer URL. Never generates; a slow engine reports ENGINE_TIMEOUT.
async function engineCheck(
  settings: SellerSettings,
  options: DoctorOptions,
): Promise<Result> {
  const { engineOffer } = settings;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { engine } = createSellerEngine(engineOffer, {
      fetch: options.probes?.fetch ?? globalThis.fetch,
      environment: options.environment,
    });
    await Promise.race([
      engine.describe(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new EngineError(ENGINE_ERROR_CODES.TIMEOUT)),
          options.probes?.engineTimeoutMs ?? DOCTOR_ENGINE_TIMEOUT_MS,
        );
      }),
    ]);
    return OK;
  } catch (error) {
    return {
      ...fail(error instanceof EngineError ? error.code : errorCode(error)),
      offer: engineOffer.index,
    };
  } finally {
    clearTimeout(timer);
  }
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
  add(
    DOCTOR_CHECKS.ENGINE,
    config.settings ? await engineCheck(config.settings, options) : notChecked,
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
