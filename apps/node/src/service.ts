// Renders the seller's background service for the account that installs it: a systemd user unit or a macOS
// launch agent, plus the commands that enable and remove it. Pure text; never touches the file system,
// runs a command or reads the environment file it names.
import { join } from 'node:path';

import { DIAGNOSTICS } from '@gyblos/config';

import {
  SERVICE,
  SERVICE_ERRORS,
  SERVICE_KINDS,
  type ServiceErrorCode,
  type ServiceKind,
} from './constants';

export class ServiceError extends Error {
  constructor(readonly code: ServiceErrorCode) {
    super(code);
  }
}

const MEBIBYTE = DIAGNOSTICS.kibibyte * DIAGNOSTICS.kibibyte;
const MEMORY_UNITS = 'KMGT';
// Startup refuses to warm an engine with less cgroup headroom than this above the seller itself, so a
// smaller MemoryMax makes the unit fail at every start. It is also the default.
const MINIMUM_MEMORY_BYTES =
  DIAGNOSTICS.minimumCgroupHeadroomBytes + SERVICE.sellerBaselineBytes;
export const DEFAULT_MEMORY_MAX = `${MINIMUM_MEMORY_BYTES / MEBIBYTE}M`;

export interface ServiceInput {
  kind: ServiceKind;
  // Absolute paths, all checked for characters a unit or plist would misread.
  nodePath: string;
  repository: string;
  home: string;
  config: string;
  environmentFile: string;
  logFile: string;
  // The installing account's operating-system home, where its units and agents live.
  accountHome: string;
  // The account's uid: launchd's GUI domain is per uid.
  uid: number;
  memoryMax: string;
  cpuQuota: string;
}

export interface ServiceLocation {
  path: string;
  disable: string[][];
  reload: string[][];
}

export interface ServicePlan extends ServiceLocation {
  contents: string;
  enable: string[][];
  notes: string[];
}

// Absolute, no control characters, and none of the characters systemd expands (`%`, `$`) or that would
// need quoting rules beyond one plain double-quoted word.
function checkPath(path: string) {
  if (!path.startsWith('/') || /[\0-\x1f\x7f"'\\%$`]/.test(path))
    throw new ServiceError(SERVICE_ERRORS.UNSAFE_PATH);
  return path;
}

export function memoryBytes(value: string) {
  const match = /^(\d+)([KMGT])?$/.exec(value);
  if (!match) throw new ServiceError(SERVICE_ERRORS.MEMORY_INVALID);
  const exponent = match[2] ? MEMORY_UNITS.indexOf(match[2]) + 1 : 0;
  return Number(match[1]) * DIAGNOSTICS.kibibyte ** exponent;
}

function checkInput(input: ServiceInput) {
  for (const path of [
    input.nodePath,
    input.repository,
    input.home,
    input.config,
    input.environmentFile,
    input.logFile,
    input.accountHome,
  ])
    checkPath(path);
  if (memoryBytes(input.memoryMax) < MINIMUM_MEMORY_BYTES)
    throw new ServiceError(SERVICE_ERRORS.MEMORY_TOO_LOW);
  if (!/^[1-9]\d{0,4}%$/.test(input.cpuQuota))
    throw new ServiceError(SERVICE_ERRORS.CPU_INVALID);
}

const quoted = (value: string) => `"${value}"`;
const nodeBin = (nodePath: string) =>
  nodePath.slice(0, nodePath.lastIndexOf('/'));
const octal = (mode: number) => mode.toString(8).padStart(4, '0');

function systemdUnit(input: ServiceInput) {
  return [
    '[Unit]',
    `Description=${SERVICE.description}`,
    'Wants=network-online.target',
    'After=network-online.target',
    `StartLimitIntervalSec=${SERVICE.startLimitIntervalSeconds}`,
    `StartLimitBurst=${SERVICE.startLimitBurst}`,
    '',
    '[Service]',
    'Type=simple',
    // A path setting: systemd takes it verbatim and refuses quotes.
    `WorkingDirectory=${input.repository}`,
    // Optional: the relay token and API keys live here, never in the unit. systemd lets it override the
    // Environment= lines below, so install refuses those names in the file.
    `EnvironmentFile=-${input.environmentFile}`,
    `Environment=${quoted(`GYBLOS_HOME=${input.home}`)}`,
    `Environment=${quoted(`GYBLOS_CONFIG=${input.config}`)}`,
    `Environment=${quoted(`PATH=${nodeBin(input.nodePath)}:${SERVICE.systemPath}`)}`,
    `ExecStart=${quoted(input.nodePath)} --import tsx ${SERVICE.entry}`,
    'KillSignal=SIGINT',
    `TimeoutStopSec=${SERVICE.stopTimeoutSeconds}`,
    'Restart=on-failure',
    `RestartSec=${SERVICE.restartSeconds}`,
    `CPUQuota=${input.cpuQuota}`,
    `MemoryMax=${input.memoryMax}`,
    `UMask=${octal(SERVICE.umask)}`,
    'NoNewPrivileges=true',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const plistString = (value: string) => `<string>${xml(value)}</string>`;

// launchd has no environment-file setting: a fixed shell line loads it, with both paths passed as
// arguments so they are never parsed as shell text. Install accepts only lines that sh and systemd read
// the same way.
const LAUNCH_SCRIPT =
  'set -a; if [ -f "$0" ]; then . "$0"; fi; set +a; exec "$1" --import tsx "$2"';

function launchAgent(input: ServiceInput) {
  const environment = {
    GYBLOS_HOME: input.home,
    GYBLOS_CONFIG: input.config,
    PATH: `${nodeBin(input.nodePath)}:${SERVICE.systemPath}`,
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${plistString(SERVICE.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[
      '/bin/sh',
      '-c',
      LAUNCH_SCRIPT,
      input.environmentFile,
      input.nodePath,
      SERVICE.entry,
    ].map((argument) => `    ${plistString(argument)}`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${plistString(input.repository)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(environment).flatMap(([key, value]) => [
      `    <key>${key}</key>`,
      `    ${plistString(value)}`,
    ]),
    '  </dict>',
    '  <key>Umask</key>',
    `  <integer>${SERVICE.umask}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    `  <integer>${SERVICE.restartSeconds}</integer>`,
    '  <key>ExitTimeOut</key>',
    `  <integer>${SERVICE.stopTimeoutSeconds}</integer>`,
    '  <key>StandardOutPath</key>',
    `  ${plistString(input.logFile)}`,
    '  <key>StandardErrorPath</key>',
    `  ${plistString(input.logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// Where the service lives and how it is removed; needs no limits or product paths, so uninstall works
// whatever the current directory or options.
export function serviceLocation(
  kind: ServiceKind,
  accountHome: string,
  uid: number,
): ServiceLocation {
  if (kind === SERVICE_KINDS.LAUNCHD) {
    const path = join(
      checkPath(accountHome),
      SERVICE.launchAgentsDirectory,
      `${SERVICE.label}.plist`,
    );
    return {
      path,
      disable: [['launchctl', 'bootout', `gui/${uid}`, path]],
      reload: [],
    };
  }
  return {
    path: join(
      checkPath(accountHome),
      SERVICE.systemdUserDirectory,
      SERVICE.unit,
    ),
    disable: [['systemctl', '--user', 'disable', '--now', SERVICE.unit]],
    reload: [['systemctl', '--user', 'daemon-reload']],
  };
}

export function servicePlan(input: ServiceInput): ServicePlan {
  checkInput(input);
  const location = serviceLocation(input.kind, input.accountHome, input.uid);
  if (input.kind === SERVICE_KINDS.LAUNCHD)
    return {
      ...location,
      contents: launchAgent(input),
      enable: [['launchctl', 'bootstrap', `gui/${input.uid}`, location.path]],
      notes: [
        'It runs while you are logged in. macOS has no per-service memory or CPU limit; the startup headroom check still applies.',
      ],
    };
  return {
    ...location,
    contents: systemdUnit(input),
    enable: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', SERVICE.unit],
    ],
    notes: [
      'A user service stops when you log out and does not start at boot unless lingering is on: `sudo loginctl enable-linger $USER`.',
    ],
  };
}
