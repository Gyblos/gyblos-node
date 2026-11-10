// The seller's background service on Windows: a scheduled task of the installing account, started at its
// logon, that runs `gyblos service-run` (service-run.ts) with no console window. Pure text, like
// service.ts: the task's XML, where it is kept and the schtasks commands that register and remove it.
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

import { SERVICE, SERVICE_ERRORS } from './constants';
import { ServiceError, type ServiceInput, type ServicePlan } from './service';

// A drive path without the characters the task's XML, Task Scheduler (`%` expands variables) or cmd's
// quoting would misread.
export function checkWindowsPath(path: string) {
  if (!/^[A-Za-z]:\\/.test(path) || /[\0-\x1f\x7f"%<>&|^]/.test(path))
    throw new ServiceError(SERVICE_ERRORS.UNSAFE_PATH);
  return path;
}

// The supervisor's pipe, named by a random secret kept in the private seller home (service-run.ts):
// pipe names are machine-wide, and another account that could compute the name could take it first.
export const pipeName = (secret: string) => `${SERVICE.pipePrefix}${secret}`;

// One task per account, so two accounts on one machine never replace or remove each other's.
export const taskName = (accountHome: string) =>
  `${SERVICE.taskName}-${createHash('sha256').update(accountHome.toLowerCase()).digest('hex').slice(0, SERVICE.taskHashCharacters)}`;

const taskFile = (accountHome: string, file: string) =>
  win32.join(
    checkWindowsPath(accountHome),
    ...SERVICE.taskDirectory.split('/'),
    file,
  );

export function taskLocation(accountHome: string) {
  return {
    path: taskFile(accountHome, SERVICE.taskFile),
    files: [taskFile(accountHome, SERVICE.taskScript)],
    disable: [['schtasks.exe', '/Delete', '/TN', taskName(accountHome), '/F']],
    reload: [],
  };
}

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

// The script the task runs: the launcher's supervisor for this home. A file, because conhost splits and
// rejoins its command line, which keeps a lone quoted path but not quotes nested inside another.
function taskScript(input: ServiceInput) {
  return [
    '@echo off',
    `rem Gyblos seller service, started by the scheduled task ${taskName(input.accountHome)}.`,
    `"${input.launcher}" ${SERVICE.run} --home "${input.home}" --config "${input.config}"`,
    '',
  ].join('\r\n');
}

// conhost --headless gives the seller a console without a window.
function action(input: ServiceInput) {
  return {
    command: '%SystemRoot%\\System32\\conhost.exe',
    arguments: `--headless cmd.exe /d /c "${taskFile(input.accountHome, SERVICE.taskScript)}"`,
  };
}

function taskXml(input: ServiceInput) {
  const run = action(input);
  const user = xml(input.windowsUser ?? '');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${SERVICE.description}</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>`,
    '  <Principals>',
    `    <Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xml(run.command)}</Command>`,
    `      <Arguments>${xml(run.arguments)}</Arguments>`,
    `      <WorkingDirectory>${xml(input.home)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

export function taskPlan(input: ServiceInput): ServicePlan {
  if (input.launcher === undefined || !input.windowsUser)
    throw new ServiceError(SERVICE_ERRORS.PLATFORM_UNSUPPORTED);
  if (!/^S-1-[0-9-]+$/.test(input.windowsUser))
    throw new ServiceError(SERVICE_ERRORS.UNSAFE_PATH);
  for (const path of [
    input.launcher,
    input.home,
    input.config,
    input.environmentFile,
    input.logFile,
  ])
    checkWindowsPath(path);
  const location = taskLocation(input.accountHome);
  return {
    ...location,
    contents: taskXml(input),
    encoding: 'utf16le',
    extra: [
      {
        path: taskFile(input.accountHome, SERVICE.taskScript),
        contents: taskScript(input),
      },
    ],
    enable: [
      [
        'schtasks.exe',
        '/Create',
        '/TN',
        taskName(input.accountHome),
        '/XML',
        location.path,
      ],
      ['schtasks.exe', '/Run', '/TN', taskName(input.accountHome)],
    ],
    notes: [
      `It starts when you log in and runs in the background without a window; its log is ${input.logFile}. Windows has no per-service memory or CPU limit; the startup headroom check still applies.`,
    ],
  };
}
