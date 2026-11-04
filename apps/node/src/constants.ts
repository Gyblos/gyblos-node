// Canonical values of the node application: the seller background service's names, locations, limits and
// error codes. Rendering lives in service.ts and the CLI in cli-service.ts. The unit and agent directories
// are operating-system locations under the account's home, not product-home paths (config/src/home.ts).
export const EXIT = { ok: 0, failure: 1 } as const;

export const SERVICE_KINDS = {
  SYSTEMD_USER: 'systemd-user',
  LAUNCHD: 'launchd',
} as const;
export type ServiceKind = (typeof SERVICE_KINDS)[keyof typeof SERVICE_KINDS];

export const SERVICE_COMMANDS = {
  INSTALL: 'install',
  UNINSTALL: 'uninstall',
} as const;
export type ServiceCommand =
  (typeof SERVICE_COMMANDS)[keyof typeof SERVICE_COMMANDS];

export const SERVICE = {
  unit: 'gyblos-seller.service',
  label: 'com.gyblos.seller',
  description: 'Gyblos seller',
  // Relative to the repository, which is also the working directory so `--import tsx` resolves.
  entry: 'apps/node/src/main.ts',
  systemdUserDirectory: '.config/systemd/user',
  launchAgentsDirectory: 'Library/LaunchAgents',
  // The daemon withdraws its listing and writes its public sequence after the first SIGINT.
  stopTimeoutSeconds: 120,
  restartSeconds: 10,
  // systemd gives up after this many failed starts within the interval instead of retrying forever.
  startLimitBurst: 5,
  startLimitIntervalSeconds: 600,
  defaultCpuQuota: '100%',
  systemPath: '/usr/local/bin:/usr/bin:/bin',
  // What the seller itself uses besides an engine's headroom: a few hundred MiB, rounded up.
  sellerBaselineBytes: 512 * 1024 * 1024,
  unitMode: 0o644,
  // Files the service runs with: owner read/write only (launchd's log, the daemon's state).
  umask: 0o077,
  environmentMaxBytes: 64 * 1024,
} as const;

// Names seller.env may not set: the unit and launch agent set these themselves, and systemd's
// EnvironmentFile and the agent's shell would let the file override them behind doctor's back.
// Shell variables follow: macOS's sh exits when a file sets a read-only one, and the others change how
// the agent's shell runs.
export const SERVICE_RESERVED_VARIABLES = [
  'GYBLOS_HOME',
  'GYBLOS_CONFIG',
  'PATH',
  'HOME',
  'UID',
  'EUID',
  'PPID',
  'SHELLOPTS',
  'BASHOPTS',
  'IFS',
  'ENV',
  'CDPATH',
  'SHELL',
  'PWD',
  'OLDPWD',
  'OPTIND',
  'OPTARG',
  'POSIXLY_CORRECT',
] as const;
// Prefixes that change how the runtime or the agent's shell loads code.
export const SERVICE_RESERVED_PREFIXES = [
  'NODE_',
  'LD_',
  'DYLD_',
  'TSX_',
  'OPENSSL_',
  'BASH',
] as const;

export const SERVICE_ERRORS = {
  UNSAFE_PATH: 'SERVICE_UNSAFE_PATH',
  MEMORY_INVALID: 'SERVICE_MEMORY_INVALID',
  MEMORY_TOO_LOW: 'SERVICE_MEMORY_TOO_LOW',
  CPU_INVALID: 'SERVICE_CPU_INVALID',
  PLATFORM_UNSUPPORTED: 'SERVICE_PLATFORM_UNSUPPORTED',
  ROOT_REFUSED: 'SERVICE_ROOT_REFUSED',
  ENVIRONMENT_UNREADABLE: 'SERVICE_ENVIRONMENT_UNREADABLE',
  ENVIRONMENT_INVALID: 'SERVICE_ENVIRONMENT_INVALID',
  ENVIRONMENT_RESERVED: 'SERVICE_ENVIRONMENT_RESERVED',
  ALREADY_INSTALLED: 'SERVICE_ALREADY_INSTALLED',
  DOCTOR_NOT_READY: 'SERVICE_DOCTOR_NOT_READY',
  COMMAND_FAILED: 'SERVICE_COMMAND_FAILED',
} as const;
export type ServiceErrorCode =
  (typeof SERVICE_ERRORS)[keyof typeof SERVICE_ERRORS];
