// Windows' owner-only files and folders: the ACL grants access only to this account, SYSTEM and
// Administrators (inherited inside a folder), and one of them owns it. Setup restricts the seller's folders
// with icacls; checks read the ACLs by SID with PowerShell before keys are used. Tools are called by
// absolute path, never through PATH.
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const WINDOWS_SIDS = {
  system: 'S-1-5-18',
  administrators: 'S-1-5-32-544',
} as const;

// Access-control types as .NET names them.
const ALLOW = 'Allow';

const system32 = () =>
  join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

export interface AclTools {
  run: (
    file: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ) => Promise<string>;
}

const defaultTools: AclTools = {
  run: async (file, args, environment = {}) =>
    (
      await run(file, args, {
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, ...environment },
      })
    ).stdout,
};

let currentSid: Promise<string> | undefined;

// "DOMAIN\user","S-1-5-21-…"
export async function userSid(tools: AclTools = defaultTools) {
  const output = await tools.run(join(system32(), 'whoami.exe'), [
    '/user',
    '/fo',
    'csv',
    '/nh',
  ]);
  const match = /"(S-1-[0-9-]+)"\s*$/.exec(output.trim());
  if (!match) throw new Error('Could not read this account SID.');
  return match[1]!;
}

// Remembered once read; a failed read is tried again next time.
function accountSid(tools: AclTools) {
  if (tools !== defaultTools) return userSid(tools);
  currentSid ??= userSid(tools).catch((error: unknown) => {
    currentSid = undefined;
    throw error;
  });
  return currentSid;
}

// Replaces inherited access with full control for this account, SYSTEM and Administrators, inherited by
// files and folders created inside.
export async function restrictDirectory(
  path: string,
  tools: AclTools = defaultTools,
) {
  const sid = await accountSid(tools);
  const grant = (who: string) => `*${who}:(OI)(CI)F`;
  await tools.run(join(system32(), 'icacls.exe'), [
    path,
    '/inheritance:r',
    '/grant:r',
    grant(sid),
    grant(WINDOWS_SIDS.system),
    grant(WINDOWS_SIDS.administrators),
  ]);
}

// The folder restricted, and everything already inside reset to inherit from it: a key restored from a
// backup or given its own permissions keeps neither.
export async function restrictTree(
  path: string,
  tools: AclTools = defaultTools,
) {
  await restrictDirectory(path, tools);
  if ((await readdir(path)).length > 0)
    await tools.run(join(system32(), 'icacls.exe'), [
      join(path, '*'),
      '/reset',
      '/T',
      '/C',
      '/Q',
    ]);
}

interface AclReport {
  owner: string;
  rules: { sid: string; type: string }[];
}

// The ACLs by SID, for each path in GYBLOS_ACL_PATHS (one per line): `item <n>`, `owner <sid>`, then
// `rule <sid> <Allow|Deny>` lines. Neither the language of Windows nor account names change the answer,
// and only .NET calls are used, so no PowerShell module has to load. Paths travel in the environment.
const ACL_SCRIPT = `$sid = [Security.Principal.SecurityIdentifier]
$n = 0
foreach ($p in ($env:GYBLOS_ACL_PATHS -split "\`n")) {
  if (-not $p) { continue }
  if ([System.IO.Directory]::Exists($p)) { $a = [System.IO.Directory]::GetAccessControl($p) }
  else { $a = [System.IO.File]::GetAccessControl($p) }
  'item ' + $n
  'owner ' + $a.GetOwner($sid).Value
  foreach ($r in $a.GetAccessRules($true, $true, $sid)) { 'rule ' + $r.IdentityReference.Value + ' ' + $r.AccessControlType }
  $n++
}`;

export function parseAcls(output: string, count: number): AclReport[] {
  const reports: AclReport[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [kind, value, type] = line.trim().split(' ');
    const current = reports.at(-1);
    if (kind === 'item' && Number(value) === reports.length)
      reports.push({ owner: '', rules: [] });
    else if (kind === 'owner' && value && current) current.owner = value;
    else if (kind === 'rule' && value && type && current)
      current.rules.push({ sid: value, type });
  }
  if (reports.length !== count || reports.some((report) => !report.owner))
    throw new Error('Could not read the Windows permissions.');
  return reports;
}

export function aclIsPrivate(report: AclReport, sid: string) {
  const allowed = new Set<string>([
    sid,
    WINDOWS_SIDS.system,
    WINDOWS_SIDS.administrators,
  ]);
  // An elevated account creates folders owned by Administrators, who can open them anyway.
  return (
    allowed.has(report.owner) &&
    report.rules.every((rule) => rule.type !== ALLOW || allowed.has(rule.sid))
  );
}

export async function readAcls(
  paths: readonly string[],
  tools: AclTools = defaultTools,
) {
  const powershell = join(
    system32(),
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const output = await tools.run(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT],
    { GYBLOS_ACL_PATHS: paths.join('\n'), PSModulePath: '' },
  );
  return parseAcls(output, paths.length);
}

export const ACL_VERDICTS = {
  PRIVATE: 'private',
  // Someone besides this account, SYSTEM and Administrators may open one of them.
  EXPOSED: 'exposed',
  // The permissions could not be read: PowerShell missing or blocked (AppLocker, constrained language).
  UNREADABLE: 'unreadable',
} as const;
export type AclVerdict = (typeof ACL_VERDICTS)[keyof typeof ACL_VERDICTS];

const privatePaths = new Set<string>();

// Whether only this account (with SYSTEM and Administrators) can open each path, in one PowerShell run.
// Paths found private are remembered for this process (keys are read at startup); nothing else is.
export async function pathsArePrivate(
  paths: readonly string[],
  tools: AclTools = defaultTools,
): Promise<AclVerdict> {
  const cache = tools === defaultTools;
  const unknown = cache
    ? paths.filter((path) => !privatePaths.has(path.toLowerCase()))
    : paths;
  if (unknown.length === 0) return ACL_VERDICTS.PRIVATE;
  let reports: AclReport[];
  let sid: string;
  try {
    [reports, sid] = await Promise.all([
      readAcls(unknown, tools),
      accountSid(tools),
    ]);
  } catch {
    return ACL_VERDICTS.UNREADABLE;
  }
  if (!reports.every((report) => aclIsPrivate(report, sid)))
    return ACL_VERDICTS.EXPOSED;
  if (cache) for (const path of unknown) privatePaths.add(path.toLowerCase());
  return ACL_VERDICTS.PRIVATE;
}
