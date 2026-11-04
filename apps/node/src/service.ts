// Renders the seller's background service: a systemd unit (system-wide for a named account, or the user's
// own) or a macOS launch agent, plus the commands that enable and remove it. Pure text; never touches the
// file system, runs a command or reads the environment file it names.
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

const MEMORY_UNITS = 'KMGT';
// Startup refuses to warm an engine with less cgroup headroom than this above the seller itself, so a
// smaller MemoryMax makes the unit fail at every start.
const MINIMUM_MEMORY_BYTES =
  DIAGNOSTICS.minimumCgroupHeadroomBytes + SERVICE.sellerBaselineBytes;

export interface ServiceInput {
  kind: ServiceKind;
  // Absolute paths, all checked for characters a unit or plist would misread.
  nodePath: string;
  repository: string;
  home: string;
  config: string;
  environmentFile: string;
  logFile: string;
  // The operating-system home of the account that runs the service (user units and launch agents).
  accountHome: string;
  // systemd-system only: the account that runs the seller; never root.
  account?: string;
  // launchd only: the GUI domain is per uid.
  uid?: number;
  memoryMax: string;
  cpuQuota: string;
}

export interface ServicePlan {
  path: string;
  contents: string;
  enable: string[][];
  disable: string[][];
  reload: string[][];
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

function checkLimits(input: ServiceInput) {
  if (memoryBytes(input.memoryMax) < MINIMUM_MEMORY_BYTES)
    throw new ServiceError(SERVICE_ERRORS.MEMORY_TOO_LOW);
  if (!/^[1-9]\d{0,4}%$/.test(input.cpuQuota))
    throw new ServiceError(SERVICE_ERRORS.CPU_INVALID);
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
  checkLimits(input);
  if (
    input.kind === SERVICE_KINDS.SYSTEMD_SYSTEM &&
    (!input.account ||
      input.account === 'root' ||
      !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.account))
  )
    throw new ServiceError(SERVICE_ERRORS.ACCOUNT_INVALID);
  if (input.kind === SERVICE_KINDS.LAUNCHD && input.uid === undefined)
    throw new ServiceError(SERVICE_ERRORS.ACCOUNT_INVALID);
}

const quoted = (value: string) => `"${value}"`;
const nodeBin = (nodePath: string) =>
  nodePath.slice(0, nodePath.lastIndexOf('/'));

function systemdUnit(input: ServiceInput) {
  const system = input.kind === SERVICE_KINDS.SYSTEMD_SYSTEM;
  return [
    '[Unit]',
    `Description=${SERVICE.description}`,
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    ...(system ? [`User=${input.account}`] : []),
    `WorkingDirectory=${quoted(input.repository)}`,
    `Environment=${quoted(`GYBLOS_HOME=${input.home}`)}`,
    `Environment=${quoted(`GYBLOS_CONFIG=${input.config}`)}`,
    `Environment=${quoted(`PATH=${nodeBin(input.nodePath)}:${SERVICE.systemPath}`)}`,
    // Optional: the relay token and API keys live here, never in the unit.
    `EnvironmentFile=-${input.environmentFile}`,
    `ExecStart=${quoted(input.nodePath)} --import tsx ${SERVICE.entry}`,
    'KillSignal=SIGINT',
    `TimeoutStopSec=${SERVICE.stopTimeoutSeconds}`,
    'Restart=on-failure',
    `RestartSec=${SERVICE.restartSeconds}`,
    `CPUQuota=${input.cpuQuota}`,
    `MemoryMax=${input.memoryMax}`,
    'NoNewPrivileges=true',
    '',
    '[Install]',
    `WantedBy=${system ? 'multi-user.target' : 'default.target'}`,
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
// arguments so they are never parsed as shell text.
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

export function servicePlan(input: ServiceInput): ServicePlan {
  checkInput(input);
  if (input.kind === SERVICE_KINDS.LAUNCHD) {
    const path = join(
      input.accountHome,
      SERVICE.launchAgentsDirectory,
      `${SERVICE.label}.plist`,
    );
    const domain = `gui/${input.uid}`;
    return {
      path,
      contents: launchAgent(input),
      enable: [['launchctl', 'bootstrap', domain, path]],
      disable: [['launchctl', 'bootout', domain, path]],
      reload: [],
      notes: [
        'macOS has no per-service memory or CPU limit; the startup headroom check still applies.',
      ],
    };
  }
  const user = input.kind === SERVICE_KINDS.SYSTEMD_USER;
  const systemctl = user ? ['systemctl', '--user'] : ['systemctl'];
  return {
    path: user
      ? join(input.accountHome, SERVICE.systemdUserDirectory, SERVICE.unit)
      : join(SERVICE.systemdSystemDirectory, SERVICE.unit),
    contents: systemdUnit(input),
    enable: [
      [...systemctl, 'daemon-reload'],
      [...systemctl, 'enable', '--now', SERVICE.unit],
    ],
    disable: [[...systemctl, 'disable', '--now', SERVICE.unit]],
    reload: [[...systemctl, 'daemon-reload']],
    notes: user
      ? [
          'A user service stops when you log out unless lingering is on: `loginctl enable-linger` (may need sudo).',
        ]
      : [],
  };
}
