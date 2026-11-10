// Owns Windows' owner-only rules on any platform, with fake tools: the account SID from whoami, the icacls
// grant that replaces inherited access, the ACL read by SID through the child's environment (never the
// script text), the private verdict, and that mode bits are not judged on Windows. The real ACLs are
// exercised by tests/windows-seller.test.ts on Windows.
import assert from 'node:assert/strict';
import test from 'node:test';

import { hasPrivateMode } from '@gyblos/runtime/private-mode';
import {
  aclIsPrivate,
  readAcl,
  restrictDirectory,
  userSid,
  WINDOWS_SIDS,
  type AclTools,
} from '@gyblos/runtime/windows-acl';

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';

function tools(outputs: Record<string, string>) {
  const calls: { file: string; args: readonly string[]; env?: object }[] = [];
  const fake: AclTools = {
    run: (file, args, env) => {
      calls.push({ file, args, ...(env ? { env } : {}) });
      const name = Object.keys(outputs).find((key) => file.endsWith(key));
      return Promise.resolve(name ? outputs[name]! : '');
    },
  };
  return { fake, calls };
}

void test('windows acl: the account SID comes from whoami, by absolute path', async () => {
  const { fake, calls } = tools({
    'whoami.exe': `"DESKTOP\\ana","${SID}"\r\n`,
  });
  assert.equal(await userSid(fake), SID);
  assert.match(calls[0]!.file, /System32[\\/]whoami\.exe$/);
  await assert.rejects(userSid(tools({ 'whoami.exe': 'garbage' }).fake));
});

void test('windows acl: restricting replaces inherited access with this account, SYSTEM and Administrators', async () => {
  const { fake, calls } = tools({
    'whoami.exe': `"DESKTOP\\ana","${SID}"`,
  });
  await restrictDirectory('C:\\Users\\ana\\.gyblos', fake);
  const icacls = calls.find((call) => call.file.endsWith('icacls.exe'))!;
  assert.deepEqual(icacls.args, [
    'C:\\Users\\ana\\.gyblos',
    '/inheritance:r',
    '/grant:r',
    `*${SID}:(OI)(CI)F`,
    `*${WINDOWS_SIDS.system}:(OI)(CI)F`,
    `*${WINDOWS_SIDS.administrators}:(OI)(CI)F`,
  ]);
});

void test('windows acl: the path reaches PowerShell in its environment, and one rule or none parses', async () => {
  const path = "C:\\Users\\ana\\.gyblos'; Remove-Item C:\\ -Recurse #";
  const single = tools({
    'powershell.exe': JSON.stringify({
      owner: SID,
      rules: { sid: SID, type: 'Allow' },
    }),
  });
  const report = await readAcl(path, single.fake);
  assert.deepEqual(report, {
    owner: SID,
    rules: [{ sid: SID, type: 'Allow' }],
  });
  const call = single.calls[0]!;
  assert.deepEqual(call.env, { GYBLOS_ACL_PATH: path });
  assert.ok(!call.args.some((argument) => argument.includes('Remove-Item')));
  const none = tools({
    'powershell.exe': JSON.stringify({ owner: SID, rules: null }),
  });
  assert.deepEqual((await readAcl('C:\\x', none.fake)).rules, []);
});

void test('windows acl: private means owned by this account and opened by no one else', () => {
  const allow = (sid: string) => ({ sid, type: 'Allow' });
  const rules = [
    allow(SID),
    allow(WINDOWS_SIDS.system),
    allow(WINDOWS_SIDS.administrators),
  ];
  assert.equal(aclIsPrivate({ owner: SID, rules }, SID), true);
  for (const outsider of [OTHER, 'S-1-1-0', 'S-1-5-11', 'S-1-5-32-545'])
    assert.equal(
      aclIsPrivate({ owner: SID, rules: [...rules, allow(outsider)] }, SID),
      false,
      outsider,
    );
  // A deny rule keeps people out; it never makes a folder less private.
  assert.equal(
    aclIsPrivate(
      { owner: SID, rules: [...rules, { sid: OTHER, type: 'Deny' }] },
      SID,
    ),
    true,
  );
  assert.equal(aclIsPrivate({ owner: OTHER, rules }, SID), false);
});

void test('mode bits decide privacy on POSIX only', () => {
  const loose = { mode: 0o100666, uid: 0 };
  assert.equal(hasPrivateMode(loose, 0o600, 'win32'), true);
  assert.equal(hasPrivateMode(loose, 0o600, 'linux'), false);
});
