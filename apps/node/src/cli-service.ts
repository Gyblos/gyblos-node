// `gyblos seller service install|uninstall`: runs the seller in the background as the installing account,
// under a systemd user unit (Linux), a launch agent (macOS) or a scheduled task with its supervisor
// (Windows, packaged release only); never as root. Install first runs the offline
// doctor with exactly the environment the service will have (seller.env, GYBLOS_HOME and GYBLOS_CONFIG), so
// a unit that cannot start is never enabled. Prints paths and variable names, never a value from the file.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';

import {
  ENVIRONMENT_SWITCH,
  NODE_ENVIRONMENT,
  RUN_MODES,
  runMode,
} from '@gyblos/config';
import { homeLayout } from '@gyblos/config/home';
import { nodeConfigPath } from '@gyblos/node/node-config-file';
import type { DoctorProbes } from '@gyblos/node/seller-doctor';
import { userSid } from '@gyblos/runtime/windows-acl';

import { doctor } from './cli-doctor';
import { commandsFor } from './cli-next';
import {
  EXIT,
  SERVICE,
  SERVICE_COMMANDS,
  SERVICE_ERRORS,
  SERVICE_KINDS,
  type ServiceCommand,
  type ServiceErrorCode,
  type ServiceKind,
} from './constants';
import {
  DEFAULT_MEMORY_MAX,
  ServiceError,
  serviceLocation,
  servicePlan,
  type ServiceInput,
} from './service';
import { readEnvironmentFile } from './service-environment';
import { stopWindowsService } from './service-run';

const HINTS: Readonly<Record<ServiceErrorCode, string>> = {
  [SERVICE_ERRORS.UNSAFE_PATH]:
    'paths must be absolute, without quotes, backslashes, `%`, `$` or control characters',
  [SERVICE_ERRORS.MEMORY_INVALID]: '--memory takes a size such as 3G or 3072M',
  [SERVICE_ERRORS.MEMORY_TOO_LOW]: `--memory must be at least ${DEFAULT_MEMORY_MAX}: startup needs its memory headroom above the seller itself`,
  [SERVICE_ERRORS.CPU_INVALID]: '--cpu takes a percentage such as 100%',
  [SERVICE_ERRORS.PLATFORM_UNSUPPORTED]:
    'services are supported on Linux (systemd), macOS (launchd) and, for the packaged release, Windows (a scheduled task)',
  [SERVICE_ERRORS.ROOT_REFUSED]:
    'install as the account that owns the seller home and keys (for example `sudo -iu <account>`), never as root',
  [SERVICE_ERRORS.ENVIRONMENT_UNREADABLE]:
    'the environment file must be a regular file you own, mode 0600 (chmod 600), not a symlink',
  [SERVICE_ERRORS.ENVIRONMENT_INVALID]:
    'each line must be NAME=value: no spaces, quotes, `$`, backticks, backslashes, `#`, `~` or shell operators in the value',
  [SERVICE_ERRORS.ENVIRONMENT_RESERVED]:
    'the environment file may not set GYBLOS_HOME, GYBLOS_CONFIG, GYBLOS_CONTAINER, GYBLOS_PACKAGED, GYBLOS_LAUNCHER, PATH, HOME, shell variables (UID, IFS, BASH*, …) or NODE_*/LD_*/DYLD_*/TSX_*/OPENSSL_* variables',
  [SERVICE_ERRORS.ALREADY_INSTALLED]:
    'run `gyblos seller service uninstall` first',
  [SERVICE_ERRORS.DOCTOR_NOT_READY]:
    'the service sees only the environment file, GYBLOS_HOME and GYBLOS_CONFIG; fix the failures above',
  [SERVICE_ERRORS.EPHEMERAL_INSTALL]:
    'this gyblos runs from a temporary cache (npx, pnpm dlx, bunx) the service could not rely on: install it with `npm install -g gyblos`, then run `gyblos seller service install`',
  [SERVICE_ERRORS.COMMAND_FAILED]:
    'see the error above; `gyblos seller service uninstall` removes the unit',
};

// Where one-off runners unpack packages (npx, pnpm dlx, bunx), or any temporary directory: a service
// started from there would lose its program when the cache or temp is cleared.
function ephemeral(launcher: string) {
  const parts = launcher.split(sep);
  return (
    parts.includes('_npx') ||
    parts.includes('dlx') ||
    parts.some((part) => part.startsWith('bunx-')) ||
    launcher.startsWith(realpathSync(tmpdir()) + sep) ||
    launcher.startsWith(tmpdir() + sep)
  );
}

// Everything that touches the operating system; tests replace it.
export interface ServiceSystem {
  platform: NodeJS.Platform;
  uid: number | undefined;
  accountHome: string;
  nodePath: string;
  repository: string;
  // Set when running as the packaged release: the service runs this launcher instead of Node and tsx.
  launcher?: string;
  run: (argv: readonly string[]) => Promise<number>;
  // Windows: the account's SID, and a graceful stop of a running supervisor (false when none runs).
  windowsUser: () => Promise<string>;
  stopWindowsService: (accountHome: string) => Promise<boolean>;
}

export interface ServiceOptions {
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

export function defaultServiceSystem(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ServiceSystem {
  // Packaged without its launcher's path fails as an unsafe path instead of writing a checkout's unit.
  const packaged = runMode(environment) === RUN_MODES.PACKAGED;
  return {
    platform: process.platform,
    uid: process.getuid?.(),
    accountHome: homedir(),
    nodePath: process.execPath,
    repository: resolve(import.meta.dirname, '../../..'),
    ...(packaged
      ? { launcher: environment[NODE_ENVIRONMENT.launcher] ?? '' }
      : {}),
    run: runCommand,
    windowsUser: () => userSid(),
    stopWindowsService,
  };
}

// Windows has no uid: the task runs as the account's SID.
const NO_UID = -1;

// The installing account, never root: doctor checks that the keys belong to the account running it.
function account(system: ServiceSystem): { kind: ServiceKind; uid: number } {
  let kind: ServiceKind;
  if (system.platform === 'win32')
    return { kind: SERVICE_KINDS.SCHEDULED_TASK, uid: NO_UID };
  if (system.platform === 'darwin') kind = SERVICE_KINDS.LAUNCHD;
  else if (system.platform === 'linux') kind = SERVICE_KINDS.SYSTEMD_USER;
  else throw new ServiceError(SERVICE_ERRORS.PLATFORM_UNSUPPORTED);
  if (system.uid === undefined || system.uid === 0)
    throw new ServiceError(SERVICE_ERRORS.ROOT_REFUSED);
  return { kind, uid: system.uid };
}

async function serviceInput(
  system: ServiceSystem,
  options: ServiceOptions,
  output: ServiceOutput,
): Promise<ServiceInput> {
  // npx unpacks into a cache it may clear; a service must run an installed copy.
  if (system.launcher && ephemeral(system.launcher))
    throw new ServiceError(SERVICE_ERRORS.EPHEMERAL_INSTALL);
  const owner = account(system);
  // From a checkout Windows has no launcher for the task to run.
  if (owner.kind === SERVICE_KINDS.SCHEDULED_TASK && !system.launcher)
    throw new ServiceError(SERVICE_ERRORS.PLATFORM_UNSUPPORTED);
  const layout = homeLayout({
    GYBLOS_HOME: resolve(output.cwd, homeLayout(output.env).root),
  });
  return {
    ...owner,
    ...(owner.kind === SERVICE_KINDS.SCHEDULED_TASK
      ? { windowsUser: await system.windowsUser() }
      : {}),
    nodePath: system.nodePath,
    repository: system.repository,
    ...(system.launcher === undefined ? {} : { launcher: system.launcher }),
    home: layout.root,
    config: nodeConfigPath(output.env, output.cwd).path,
    environmentFile: layout.files.sellerEnvironment,
    logFile: layout.files.serviceLog,
    accountHome: system.accountHome,
    memoryMax: options.memory ?? DEFAULT_MEMORY_MAX,
    cpuQuota: options.cpu ?? SERVICE.defaultCpuQuota,
  };
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const UTF16_BOM = Buffer.from('\ufeff', 'utf16le');

async function runAll(
  commands: readonly string[][],
  system: ServiceSystem,
  output: ServiceOutput,
) {
  for (const command of commands)
    if ((await system.run(command)) !== EXIT.ok) {
      output.stderr(`command failed: ${command.join(' ')}\n`);
      throw new ServiceError(SERVICE_ERRORS.COMMAND_FAILED);
    }
}

async function install(
  system: ServiceSystem,
  options: ServiceOptions,
  output: ServiceOutput,
) {
  const input = await serviceInput(system, options, output);
  const plan = servicePlan(input);
  if (input.launcher?.includes(`${sep}.nvm${sep}versions${sep}`))
    output.stdout(
      'Note: this gyblos belongs to one nvm Node version; removing that version, or updating gyblos under another, leaves the service on the old copy. Reinstall the service after updating.\n',
    );
  const values = await readEnvironmentFile(input.environmentFile);
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
        // Its hints spell commands as the packaged release types them.
        ...(input.launcher === undefined
          ? {}
          : { [NODE_ENVIRONMENT.packaged]: ENVIRONMENT_SWITCH.on }),
      },
      cwd: output.cwd,
      probes: output.doctor,
      online: false,
    },
    output,
  );
  if (!ready) throw new ServiceError(SERVICE_ERRORS.DOCTOR_NOT_READY);
  if (options.dryRun) {
    output.stdout(`Unit file: ${plan.path}\n${plan.contents}Commands:\n`);
    for (const command of plan.enable)
      output.stdout(`  ${command.join(' ')}\n`);
    return;
  }
  if (await exists(plan.path))
    throw new ServiceError(SERVICE_ERRORS.ALREADY_INSTALLED);
  await mkdir(dirname(plan.path), { recursive: true });
  await writeFile(
    plan.path,
    plan.encoding
      ? Buffer.concat([UTF16_BOM, Buffer.from(plan.contents, plan.encoding)])
      : plan.contents,
    { flag: 'wx', mode: SERVICE.unitMode },
  );
  await runAll(plan.enable, system, output);
  output.stdout(`Installed and started: ${plan.path}\n`);
  for (const note of plan.notes) output.stdout(`Note: ${note}\n`);
}

async function uninstall(
  system: ServiceSystem,
  options: ServiceOptions,
  output: ServiceOutput,
) {
  const { kind, uid } = account(system);
  const location = serviceLocation(kind, system.accountHome, uid);
  if (!(await exists(location.path))) {
    output.stdout(`Not installed: ${location.path}\n`);
    return;
  }
  if (options.dryRun) {
    output.stdout(`Would stop and remove ${location.path}\n`);
    return;
  }
  // Windows: the supervisor stops the seller gracefully first; removing the task would not.
  if (kind === SERVICE_KINDS.SCHEDULED_TASK)
    await system.stopWindowsService(system.accountHome);
  // Stopping may fail when the service is already stopped; removal proceeds either way.
  for (const command of location.disable) await system.run(command);
  await rm(location.path);
  await runAll(location.reload, system, output);
  output.stdout(`Removed: ${location.path}\n`);
}

const COMMANDS = {
  [SERVICE_COMMANDS.INSTALL]: install,
  [SERVICE_COMMANDS.UNINSTALL]: uninstall,
} as const;

const isServiceCommand = (value: string | undefined): value is ServiceCommand =>
  value === SERVICE_COMMANDS.INSTALL || value === SERVICE_COMMANDS.UNINSTALL;

export async function serviceCommand(
  command: string | undefined,
  options: ServiceOptions,
  output: ServiceOutput,
  system: ServiceSystem = defaultServiceSystem(),
) {
  if (!isServiceCommand(command)) return undefined;
  try {
    await COMMANDS[command](system, options, output);
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    output.stderr(
      `${error.code}: ${commandsFor(runMode(output.env), HINTS[error.code])}\n`,
    );
    return EXIT.failure;
  }
}
