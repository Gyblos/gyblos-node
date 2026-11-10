// Canonical values of the node application: the seller background service's names, locations, limits and
// error codes, `seller init`'s defaults and codes, and `seller status`'s windows, limits and results.
// Rendering lives in service.ts and the CLIs in cli-service.ts, cli-init.ts and cli-status.ts. The unit and
// agent directories are operating-system locations under the account's home, not product-home paths
// (config/src/home.ts).
// 130 is the shell's code for a run stopped with Ctrl-C.
export const EXIT = { ok: 0, failure: 1, interrupted: 130 } as const;

export const SERVICE_KINDS = {
  SYSTEMD_USER: 'systemd-user',
  LAUNCHD: 'launchd',
  SCHEDULED_TASK: 'scheduled-task',
} as const;
export type ServiceKind = (typeof SERVICE_KINDS)[keyof typeof SERVICE_KINDS];

export const SERVICE_COMMANDS = {
  INSTALL: 'install',
  UNINSTALL: 'uninstall',
} as const;
export type ServiceCommand =
  (typeof SERVICE_COMMANDS)[keyof typeof SERVICE_COMMANDS];

// Owner read/write only for files the service creates (launchd's log, the daemon's state).
const SERVICE_UMASK = 0o077;

export const SERVICE = {
  unit: 'gyblos-seller.service',
  label: 'com.gyblos.seller',
  description: 'Gyblos seller',
  // Relative to the repository, which is also the working directory so `--import tsx` resolves; the
  // daemon is its `start` command.
  entry: 'apps/node/src/bin.ts',
  start: 'start',
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
  umask: SERVICE_UMASK,
  // systemd's UMask= spelling of the same value.
  umaskOctal: SERVICE_UMASK.toString(8).padStart(4, '0'),
  environmentMaxBytes: 64 * 1024,
  // Windows: a per-user scheduled task started at logon runs `service-run`, a supervisor that keeps the
  // daemon running and stops it gracefully when asked through its named pipe.
  taskName: 'Gyblos\\Seller',
  taskDirectory: 'AppData/Local/Gyblos',
  taskFile: 'seller-task.xml',
  run: 'service-run',
  pipePrefix: '\\\\.\\pipe\\gyblos-seller-',
  stopRequest: 'stop',
  logMode: 0o600,
  pipeHashCharacters: 16,
} as const;

// Names seller.env may not set: the unit and launch agent set these themselves, and systemd's
// EnvironmentFile and the agent's shell would let the file override them behind doctor's back.
// Shell variables follow: macOS's sh exits when a file sets a read-only one, and the others change how
// the agent's shell runs.
export const SERVICE_RESERVED_VARIABLES = [
  'GYBLOS_HOME',
  'GYBLOS_CONFIG',
  // How the seller was installed is the installer's and the launcher's to say, not seller.env's.
  'GYBLOS_CONTAINER',
  'GYBLOS_PACKAGED',
  'GYBLOS_LAUNCHER',
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
  // Windows: where programs, PowerShell modules and the account's folders are found.
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'PSMODULEPATH',
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
  EPHEMERAL_INSTALL: 'SERVICE_EPHEMERAL_INSTALL',
} as const;
export type ServiceErrorCode =
  (typeof SERVICE_ERRORS)[keyof typeof SERVICE_ERRORS];

// `gyblos seller init`: the starting values it offers and its error codes.
export const INIT_DEFAULTS = {
  // The dedicated selling Ollama of docs/running-a-node.md, apart from the Ollama app's 11434.
  ollamaUrl: 'http://127.0.0.1:11435',
  ollamaModel: 'qwen3:0.6b',
  openaiUrl: 'https://api.openai.com/v1',
  anthropicUrl: 'https://api.anthropic.com',
  openaiKeyEnv: 'OPENAI_API_KEY',
  anthropicKeyEnv: 'ANTHROPIC_API_KEY',
  dailyTokenCap: '200000',
  perBuyerCap: '5000',
} as const;
// Owner only: an engine URL may carry a provider key in its path.
export const INIT_FILE_MODE = 0o600;

export const INIT_ERRORS = {
  MISSING_VALUE: 'INIT_MISSING_VALUE',
  INVALID_ENGINE: 'INIT_INVALID_ENGINE',
  INVALID_NUMBER: 'INIT_INVALID_NUMBER',
  CONFIG_INVALID: 'INIT_CONFIG_INVALID',
  FILE_EXISTS: 'INIT_FILE_EXISTS',
  UNSAFE_PATH: 'INIT_UNSAFE_PATH',
  WRITE_FAILED: 'INIT_WRITE_FAILED',
  CANCELLED: 'INIT_CANCELLED',
} as const;
export type InitErrorCode = (typeof INIT_ERRORS)[keyof typeof INIT_ERRORS];

// `gyblos seller status`: its day window (the week is the receipts' own retention), its file and probe
// bounds and how far it pages the discovery index.
export const STATUS = {
  dayMs: 86_400_000,
  secondMs: 1000,
  maxOffers: 64,
  statusFileBytes: 64 * 1024,
  probeTimeoutMs: 5_000,
  probeOutputCharacters: 64 * 1024,
  indexPageSize: 200,
  maxIndexPages: 10,
  indexTimeoutMs: 10_000,
} as const;

export const SERVICE_STATES = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  NOT_INSTALLED: 'not installed',
  UNKNOWN: 'unknown',
} as const;
export type ServiceState = (typeof SERVICE_STATES)[keyof typeof SERVICE_STATES];

export const STATUS_RESULTS = {
  RUNNING: 'RUNNING',
  STARTING: 'STARTING',
  // The last start failed: status.json says failed, or a restart is under way after a failure.
  FAILING: 'FAILING',
  STOPPED: 'STOPPED',
  NOT_CONFIRMED: 'NOT_CONFIRMED',
} as const;
export type StatusResult = (typeof STATUS_RESULTS)[keyof typeof STATUS_RESULTS];

// Why `seller status` or `seller register` found no usable seller role in this home.
export const SELLER_ROLE_ERRORS = {
  MISSING: 'SELLER_ROLE_MISSING',
  UNREADABLE: 'SELLER_ROLE_UNREADABLE',
  NOT_SELLER: 'SELLER_ROLE_NOT_SELLER',
} as const;
export type SellerRoleErrorCode =
  (typeof SELLER_ROLE_ERRORS)[keyof typeof SELLER_ROLE_ERRORS];

// `gyblos seller register`: the index call's deadline, where the invite comes from and its own codes.
export const REGISTER = {
  timeoutMs: 15_000,
  inviteEnv: 'GYBLOS_INVITE',
  lamportsPerSol: 1_000_000_000n,
  solDecimals: 9,
  // What to wait for when the registration cannot be estimated without SOL: 0.02, which covers the
  // one-time 8004 registration (about 0.01 SOL) with margin.
  simulationFundingLamports: 20_000_000n,
  // How many times, on a terminal, registration waits for SOL and tries again before giving up.
  fundWaits: 3,
} as const;

export const REGISTER_ERRORS = {
  NO_INVITE: 'REGISTER_NO_INVITE',
  INVITE_FORMAT: 'REGISTER_INVITE_FORMAT',
  CONFIG_INVALID: 'REGISTER_CONFIG_INVALID',
  IDENTITY_UNAVAILABLE: 'REGISTER_IDENTITY_UNAVAILABLE',
  CANCELLED: 'REGISTER_CANCELLED',
} as const;
