// Canonical values of the node application: the seller background service's names, locations, limits and
// error codes. Rendering lives in service.ts and the CLI in cli-service.ts.
export const SERVICE_KINDS = {
  SYSTEMD_SYSTEM: 'systemd-system',
  SYSTEMD_USER: 'systemd-user',
  LAUNCHD: 'launchd',
} as const;
export type ServiceKind = (typeof SERVICE_KINDS)[keyof typeof SERVICE_KINDS];

export const SERVICE = {
  unit: 'gyblos-seller.service',
  label: 'com.gyblos.seller',
  description: 'Gyblos seller',
  // Relative to the repository, which is also the working directory so `--import tsx` resolves.
  entry: 'apps/node/src/main.ts',
  systemdSystemDirectory: '/etc/systemd/system',
  systemdUserDirectory: '.config/systemd/user',
  launchAgentsDirectory: 'Library/LaunchAgents',
  // The daemon withdraws its listing and writes its public sequence after the first SIGINT.
  stopTimeoutSeconds: 120,
  restartSeconds: 10,
  defaultMemoryMax: '2G',
  defaultCpuQuota: '100%',
  systemPath: '/usr/local/bin:/usr/bin:/bin',
  // What the seller itself uses besides an engine's headroom: a few hundred MiB, rounded up.
  sellerBaselineBytes: 512 * 1024 * 1024,
} as const;

export const SERVICE_ERRORS = {
  UNSAFE_PATH: 'SERVICE_UNSAFE_PATH',
  MEMORY_INVALID: 'SERVICE_MEMORY_INVALID',
  MEMORY_TOO_LOW: 'SERVICE_MEMORY_TOO_LOW',
  CPU_INVALID: 'SERVICE_CPU_INVALID',
  ACCOUNT_INVALID: 'SERVICE_ACCOUNT_INVALID',
} as const;
export type ServiceErrorCode =
  (typeof SERVICE_ERRORS)[keyof typeof SERVICE_ERRORS];

export const SERVICE_CLI_ERRORS = {
  PLATFORM_UNSUPPORTED: 'SERVICE_PLATFORM_UNSUPPORTED',
  ACCOUNT_NOT_ALLOWED: 'SERVICE_ACCOUNT_NOT_ALLOWED',
  ENVIRONMENT_PERMISSIONS: 'SERVICE_ENVIRONMENT_PERMISSIONS',
  ENVIRONMENT_INVALID: 'SERVICE_ENVIRONMENT_INVALID',
  ALREADY_INSTALLED: 'SERVICE_ALREADY_INSTALLED',
  DOCTOR_NOT_READY: 'SERVICE_DOCTOR_NOT_READY',
  COMMAND_FAILED: 'SERVICE_COMMAND_FAILED',
} as const;
export type ServiceCliError =
  (typeof SERVICE_CLI_ERRORS)[keyof typeof SERVICE_CLI_ERRORS];
