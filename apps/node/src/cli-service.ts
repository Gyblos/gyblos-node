// `gyblos seller service install|uninstall`: runs the seller in the background under systemd (Linux) or
// launchd (macOS). Install first runs the offline doctor with exactly the environment the service will have
// (the private seller.env, GYBLOS_HOME and GYBLOS_CONFIG), so a unit that cannot start is never enabled.
// Prints paths and variable names, never a value read from the environment file.
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { homeLayout } from '@gyblos/config/home';
import { NODE_CONFIG_FILENAME } from '@gyblos/node/constants';
import type { DoctorProbes } from '@gyblos/node/seller-doctor';

import { doctor } from './cli-doctor';
import {
  SERVICE,
  SERVICE_CLI_ERRORS,
  SERVICE_ERRORS,
  SERVICE_KINDS,
  type ServiceCliError,
  type ServiceErrorCode,
  type ServiceKind,
} from './constants';
import { ServiceError, servicePlan, type ServiceInput } from './service';

const HINTS: Readonly<Record<ServiceCliError | ServiceErrorCode, string>> = {
  [SERVICE_ERRORS.UNSAFE_PATH]:
    'paths must be absolute, without quotes, backslashes, `%`, `$` or control characters',
  [SERVICE_ERRORS.MEMORY_INVALID]: '--memory takes a size such as 2G or 3072M',
  [SERVICE_ERRORS.MEMORY_TOO_LOW]:
    '--memory must be at least 2G: startup needs 1.5 GiB of headroom above the seller itself',
  [SERVICE_ERRORS.CPU_INVALID]: '--cpu takes a percentage such as 100%',
  [SERVICE_ERRORS.ACCOUNT_INVALID]:
    'run as root with --user <account> (never root) for a system service',
  [SERVICE_CLI_ERRORS.PLATFORM_UNSUPPORTED]:
    'services are supported on Linux (systemd) and macOS (launchd)',
  [SERVICE_CLI_ERRORS.ACCOUNT_NOT_ALLOWED]:
    '--user is only for a system service installed as root',
  [SERVICE_CLI_ERRORS.ENVIRONMENT_PERMISSIONS]:
    'the environment file must be a regular file readable only by you: chmod 600',
  [SERVICE_CLI_ERRORS.ENVIRONMENT_INVALID]:
    'each line of the environment file must be NAME=value',
  [SERVICE_CLI_ERRORS.ALREADY_INSTALLED]:
    'run `gyblos seller service uninstall` first',
  [SERVICE_CLI_ERRORS.DOCTOR_NOT_READY]:
    'the service sees only the environment file, GYBLOS_HOME and GYBLOS_CONFIG; fix the failures above',
  [SERVICE_CLI_ERRORS.COMMAND_FAILED]:
    'see the error above; `gyblos seller service uninstall` removes the unit',
};

const EXIT = { ok: 0, failure: 1 } as const;
const PRIVATE_MODE_MASK = 0o077;
const UNIT_MODE = 0o644;

// Everything that touches the operating system; tests replace it.
export interface ServiceSystem {
  platform: NodeJS.Platform;
  uid: number | undefined;
  accountHome: string;
  nodePath: string;
  repository: string;
  run: (argv: readonly string[]) => Promise<number>;
}

export interface ServiceOptions {
  account?: string;
  memory?: string;
  cpu?: string;
  dryRun: boolean;
}

interface ServiceOutput {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  doctor?: DoctorProbes;
}

function runCommand(argv: readonly string[]) {
  return new Promise<number>((done) => {
    const [command, ...args] = argv;
    const child = spawn(command!, args, { stdio: 'inherit' });
    child.on('error', () => done(EXIT.failure));
    child.on('close', (code) => done(code ?? EXIT.failure));
  });
}

export function defaultServiceSystem(): ServiceSystem {
  return {
    platform: process.platform,
    uid: process.getuid?.(),
    accountHome: homedir(),
    nodePath: process.execPath,
    repository: resolve(import.meta.dirname, '../../..'),
    run: runCommand,
  };
}

class ServiceCliFailure extends Error {
  constructor(readonly code: ServiceCliError) {
    super(code);
  }
}

function serviceKind(system: ServiceSystem, options: ServiceOptions) {
  let kind: ServiceKind;
  if (system.platform === 'darwin') kind = SERVICE_KINDS.LAUNCHD;
  else if (system.platform !== 'linux')
    throw new ServiceCliFailure(SERVICE_CLI_ERRORS.PLATFORM_UNSUPPORTED);
  else if (system.uid === 0) kind = SERVICE_KINDS.SYSTEMD_SYSTEM;
  else kind = SERVICE_KINDS.SYSTEMD_USER;
  if (options.account !== undefined && kind !== SERVICE_KINDS.SYSTEMD_SYSTEM)
    throw new ServiceCliFailure(SERVICE_CLI_ERRORS.ACCOUNT_NOT_ALLOWED);
  return kind;
}

function serviceInput(
  system: ServiceSystem,
  options: ServiceOptions,
  output: ServiceOutput,
): ServiceInput {
  const home = resolve(output.cwd, homeLayout(output.env).root);
  const { files } = homeLayout({ GYBLOS_HOME: home });
  return {
    kind: serviceKind(system, options),
    nodePath: system.nodePath,
    repository: system.repository,
    home,
    config: resolve(
      output.cwd,
      output.env.GYBLOS_CONFIG || NODE_CONFIG_FILENAME,
    ),
    environmentFile: files.sellerEnvironment,
    logFile: files.serviceLog,
    accountHome: system.accountHome,
    account: options.account,
    uid: system.uid,
    memoryMax: options.memory ?? SERVICE.defaultMemoryMax,
    cpuQuota: options.cpu ?? SERVICE.defaultCpuQuota,
  };
}

// NAME=value lines, as systemd's EnvironmentFile and `set -a; . file` both read them: blank lines and
// comments are skipped, `export ` and one pair of surrounding quotes are accepted.
export function parseEnvironmentFile(text: string) {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match)
      throw new ServiceCliFailure(SERVICE_CLI_ERRORS.ENVIRONMENT_INVALID);
    const value = match[2]!;
    values[match[1]!] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return values;
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readEnvironmentFile(path: string, uid: number | undefined) {
  const info = await statIfPresent(path);
  if (!info) return undefined;
  if (
    !info.isFile() ||
    (info.mode & PRIVATE_MODE_MASK) !== 0 ||
    (uid !== undefined && uid !== 0 && info.uid !== uid)
  )
    throw new ServiceCliFailure(SERVICE_CLI_ERRORS.ENVIRONMENT_PERMISSIONS);
  return parseEnvironmentFile(await readFile(path, 'utf8'));
}

function printPlan(
  plan: ReturnType<typeof servicePlan>,
  output: ServiceOutput,
) {
  output.stdout(`Unit file: ${plan.path}\n${plan.contents}`);
  output.stdout('Commands:\n');
  for (const command of plan.enable) output.stdout(`  ${command.join(' ')}\n`);
}

const exists = async (path: string) =>
  (await statIfPresent(path)) !== undefined;

async function runAll(
  commands: readonly string[][],
  system: ServiceSystem,
  output: ServiceOutput,
) {
  for (const command of commands)
    if ((await system.run(command)) !== EXIT.ok) {
      output.stderr(`command failed: ${command.join(' ')}\n`);
      throw new ServiceCliFailure(SERVICE_CLI_ERRORS.COMMAND_FAILED);
    }
}

async function install(
  system: ServiceSystem,
  options: ServiceOptions,
  output: ServiceOutput,
) {
  const input = serviceInput(system, options, output);
  const plan = servicePlan(input);
  const values = await readEnvironmentFile(input.environmentFile, system.uid);
  if (!values)
    output.stdout(
      `No ${input.environmentFile}: put GYBLOS_RELAY_TOKEN (and any api_key_env) there, mode 0600.\n`,
    );
  const ready = await doctor(
    {
      env: {
        ...values,
        GYBLOS_HOME: input.home,
        GYBLOS_CONFIG: input.config,
      },
      cwd: output.cwd,
      probes: output.doctor,
      online: false,
    },
    output,
  );
  if (!ready) throw new ServiceCliFailure(SERVICE_CLI_ERRORS.DOCTOR_NOT_READY);
  if (options.dryRun) {
    printPlan(plan, output);
    return;
  }
  if (await exists(plan.path))
    throw new ServiceCliFailure(SERVICE_CLI_ERRORS.ALREADY_INSTALLED);
  await mkdir(dirname(plan.path), { recursive: true });
  await writeFile(plan.path, plan.contents, { flag: 'wx', mode: UNIT_MODE });
  await runAll(plan.enable, system, output);
  output.stdout(`Installed and started: ${plan.path}\n`);
  for (const note of plan.notes) output.stdout(`Note: ${note}\n`);
}

async function uninstall(
  system: ServiceSystem,
  options: ServiceOptions,
  output: ServiceOutput,
) {
  const plan = servicePlan(serviceInput(system, options, output));
  if (!(await exists(plan.path))) {
    output.stdout(`Not installed: ${plan.path}\n`);
    return;
  }
  if (options.dryRun) {
    output.stdout(`Would stop and remove ${plan.path}\n`);
    return;
  }
  // Stopping may fail when the service is already stopped; removal proceeds either way.
  for (const command of plan.disable) await system.run(command);
  await rm(plan.path);
  await runAll(plan.reload, system, output);
  output.stdout(`Removed: ${plan.path}\n`);
}

export async function serviceCommand(
  command: string | undefined,
  options: ServiceOptions,
  output: ServiceOutput,
  system: ServiceSystem = defaultServiceSystem(),
) {
  if (command !== 'install' && command !== 'uninstall') return undefined;
  try {
    await (command === 'install' ? install : uninstall)(
      system,
      options,
      output,
    );
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof ServiceError || error instanceof ServiceCliFailure))
      throw error;
    output.stderr(`${error.code}: ${HINTS[error.code]}\n`);
    return EXIT.failure;
  }
}
