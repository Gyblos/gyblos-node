// Windows' owner-only directory: its ACL grants access only to this account, SYSTEM and Administrators,
// inherited by everything created inside, and one of them owns it. Restricting runs icacls once when a
// private directory is created; checking reads the ACL by SID with PowerShell (locale-independent), once
// per directory and process. The tools are called by absolute path, never through PATH.
import { execFile } from 'node:child_process';
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

const accountSid = (tools: AclTools) =>
  tools === defaultTools ? (currentSid ??= userSid(tools)) : userSid(tools);

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

interface AclReport {
  owner: string;
  rules: { sid: string; type: string }[];
}

// The ACL by SID, one line each (`owner <sid>`, `rule <sid> <Allow|Deny>`), so neither the language of
// Windows nor account names change the answer. Only .NET calls: no PowerShell module has to load.
const ACL_SCRIPT = `$sid = [Security.Principal.SecurityIdentifier]
$a = (New-Object System.IO.DirectoryInfo $env:GYBLOS_ACL_PATH).GetAccessControl()
'owner ' + $a.GetOwner($sid).Value
foreach ($r in $a.GetAccessRules($true, $true, $sid)) { 'rule ' + $r.IdentityReference.Value + ' ' + $r.AccessControlType }`;

export function parseAcl(output: string): AclReport {
  let owner = '';
  const rules: AclReport['rules'] = [];
  for (const line of output.split(/\r?\n/)) {
    const [kind, sid, type] = line.trim().split(' ');
    if (kind === 'owner' && sid) owner = sid;
    else if (kind === 'rule' && sid && type) rules.push({ sid, type });
  }
  if (!owner) throw new Error('Could not read the folder ACL.');
  return { owner, rules };
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

export async function readAcl(path: string, tools: AclTools = defaultTools) {
  const powershell = join(
    system32(),
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  // The path travels in the child's environment, never inside the script text.
  const output = await tools.run(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT],
    { GYBLOS_ACL_PATH: path, PSModulePath: '' },
  );
  return parseAcl(output);
}

const checked = new Map<string, Promise<boolean>>();

// Whether only this account (with SYSTEM and Administrators) can open what is inside `path`.
export function directoryIsPrivate(
  path: string,
  tools: AclTools = defaultTools,
): Promise<boolean> {
  const verdict = async () =>
    aclIsPrivate(await readAcl(path, tools), await accountSid(tools));
  if (tools !== defaultTools) return verdict();
  let result = checked.get(path);
  if (!result) {
    result = verdict().catch(() => false);
    checked.set(path, result);
  }
  return result;
}
