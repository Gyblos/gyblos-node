// Read-only preflight for the seller daemon: the checks `pnpm node:start` would fail on, without starting,
// spawning or writing anything. Results carry static codes only; the RPC URL, relay token, key contents and
// home location never leave this module. Network use is limited to describing each offer's engine: one on
// this machine always, a remote API only with --online, since that call carries the seller's API key;
// --online also reads which token accounts a paid claim would pay into are missing.
import { resolve } from 'node:path';

import {
  NODE_ENVIRONMENT,
  PROTOCOL_FEE,
  ROLE_FILES,
  ROLE_KEY_FILES,
  type HomeEnvironment,
} from '@gyblos/config';
import {
  CONTROL_METERING_MODES,
  OFFER_PRICING_KINDS,
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
import { loadRole, roleKeyFilesStatus, type RoleConfig } from './roles';
import type { SellerCatalogOffer } from './seller-offer';
import {
  paymentAccountsVerdict,
  type PaymentAccountsProbes,
} from './seller-payment-accounts';
import {
  sellerBaseSettings,
  sellerSettings,
  type SellerBaseSettings,
  type SellerOfferSettings,
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
  // gyblos.toml [[offers]] in order, once every entry is servable.
  offers: SellerCatalogOffer[] | undefined;
  publication: string | undefined;
  limits: SellerLimits | undefined;
}
export interface DoctorProbes {
  // Throws when the pinned tokenizer files are absent or do not match their hashes.
  tokenizer?: (environment: HomeEnvironment) => Promise<unknown>;
  // The engines' transport; tests serve a synthetic provider.
  fetch?: typeof fetch;
  // The chain the role's RPC serves and its payment token accounts (--online).
  genesis?: PaymentAccountsProbes['genesis'];
  paymentAccounts?: PaymentAccountsProbes['paymentAccounts'];
}
export interface DoctorOptions {
  environment: HomeEnvironment;
  cwd: string;
  probes?: DoctorProbes;
  // Also describe remote engines.
  online?: boolean;
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
    // As the daemon does: paid offers are served through the role's payment keys.
    const settings = sellerSettings(file, options.environment, {
      paidSelling: true,
    });
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
    config,
    seller: { nodeId: config.nodeId, owner: config.owner },
  };
}

// The payout and payment keys paid selling uses, as the daemon checks them; metadata only. With
// --online, also the token accounts a paid claim pays into, which startup creates when missing.
async function paymentsCheck(
  config: RoleConfig,
  options: DoctorOptions,
): Promise<Result> {
  if (
    config.role !== P2P_ROLES.SELLER ||
    config.payTo === undefined ||
    config.facilitator === undefined ||
    config.authorizer === undefined
  )
    return fail(NODE_ERROR_CODES.SELLER_PAYMENT_ROLE_MISSING);
  if (
    [config.owner, config.facilitator, config.authorizer].includes(config.payTo)
  )
    return fail(NODE_ERROR_CODES.SELLER_PAYMENT_DESCRIPTION_INVALID);
  try {
    const status = await roleKeyFilesStatus(
      P2P_ROLES.SELLER,
      [ROLE_KEY_FILES.facilitator, ROLE_KEY_FILES.authorizer],
      options.environment,
    );
    if (status !== 'ok')
      return fail(
        status === 'missing'
          ? DOCTOR_CODES.KEYS_MISSING
          : DOCTOR_CODES.KEY_PERMISSIONS,
      );
  } catch (error) {
    return fail(errorCode(error));
  }
  if (!options.online) return OK;
  const verdict = await paymentAccountsVerdict(
    {
      rpcUrl: config.rpcUrl,
      mint: config.mint,
      owners: [config.payTo, PROTOCOL_FEE.treasury, config.facilitator],
    },
    options.probes ?? {},
  );
  return {
    ready: OK,
    // Startup creates them.
    missing: warn(DOCTOR_CODES.PAYMENT_ACCOUNTS_MISSING),
    unchecked: warn(DOCTOR_CODES.PAYMENT_ACCOUNTS_UNCHECKED),
    // Startup refuses both.
    unusable: fail(DOCTOR_CODES.PAYMENT_ACCOUNTS_UNUSABLE),
    'other-network': fail(NODE_ERROR_CODES.SELLER_PAYMENT_NETWORK_MISMATCH),
  }[verdict];
}

const engineDependencies = (options: DoctorOptions) => ({
  fetch: options.probes?.fetch ?? globalThis.fetch,
  environment: options.environment,
});

// Needed unless every offer is known to be declared by its provider.
async function tokenizerCheck(
  options: DoctorOptions,
  offers: readonly SellerOfferSettings[] | undefined,
): Promise<Result> {
  const recounts = (offer: SellerOfferSettings) =>
    createSellerEngine(offer.engine, engineDependencies(options)).metering
      .mode === CONTROL_METERING_MODES.RECOUNTED;
  if (offers && !offers.some(recounts))
    return { status: DOCTOR_STATUS.OK, code: DOCTOR_CODES.NOT_NEEDED };
  try {
    await (options.probes?.tokenizer ?? modelTokenizer)(options.environment);
    return OK;
  } catch {
    return fail(DOCTOR_CODES.TOKENIZER_UNAVAILABLE);
  }
}

// Describes one offer's engine the way warmup starts (for Ollama, the model list and pinned digest at the
// offer URL; for a remote API, its model list), within the adapter's own deadline. Never generates. A
// remote engine is described only with --online.
async function engineCheck(
  engineOffer: SellerOfferSettings['engine'],
  options: DoctorOptions,
): Promise<Result> {
  try {
    const { engine, readiness } = createSellerEngine(
      engineOffer,
      engineDependencies(options),
    );
    if (!readiness.localResources && !options.online)
      return {
        ...warn(DOCTOR_CODES.REMOTE_ENGINE_NOT_CHECKED),
        offer: engineOffer.index,
      };
    await engine.describe();
    return { ...OK, offer: engineOffer.index };
  } catch (error) {
    return {
      ...fail(error instanceof EngineError ? error.code : errorCode(error)),
      offer: engineOffer.index,
    };
  }
}

// Startup needs one ready engine and retries the others, so a down engine fails only when no offer's
// engine answers or may answer (a remote engine left unchecked), and is otherwise a warning.
export function engineStatuses<
  T extends Pick<DoctorCheck, 'status'> & { code?: DoctorResultCode },
>(engines: readonly T[]): T[] {
  const anyReady = engines.some(
    (result) =>
      result.status === DOCTOR_STATUS.OK ||
      result.code === DOCTOR_CODES.REMOTE_ENGINE_NOT_CHECKED,
  );
  return engines.map((result) =>
    anyReady && result.status === DOCTOR_STATUS.FAIL
      ? { ...result, status: DOCTOR_STATUS.WARN }
      : result,
  );
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
  add(
    DOCTOR_CHECKS.TOKENIZER,
    await tokenizerCheck(options, config.settings?.offers),
  );
  // One line per offer, in order.
  if (config.settings) {
    const engines: Result[] = [];
    for (const { engine } of config.settings.offers)
      engines.push(await engineCheck(engine, options));
    for (const result of engineStatuses(engines))
      add(DOCTOR_CHECKS.ENGINE, result);
  } else add(DOCTOR_CHECKS.ENGINE, notChecked);
  add(
    DOCTOR_CHECKS.RELAYS,
    config.base ? relaysCheck(config.base) : notChecked,
  );
  if (
    config.settings?.offers.some(
      ({ offer }) => offer.kind === OFFER_PRICING_KINDS.PAID,
    )
  )
    add(
      DOCTOR_CHECKS.PAYMENTS,
      role.config ? await paymentsCheck(role.config, options) : notChecked,
    );
  return {
    checks,
    configIssues: config.issues,
    seller: role.seller,
    offers: config.settings?.offers.map(({ offer }) => offer),
    publication: config.settings?.publication?.baseUrl,
    limits: config.settings?.limits,
  };
}
