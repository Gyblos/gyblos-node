// Owns Windows' owner-only rules on any platform, with fake tools: the account SID from whoami, the icacls
// grant that replaces inherited access, the ACL read by SID through the child's environment (never the
// script text), the private verdict, and that mode bits are not judged on Windows. The real ACLs are
// exercised by tests/windows-seller.test.ts on Windows.
import assert from 'node:assert/strict';
import test from 'node:test';

import { hasPrivateMode } from '@gyblos/runtime/private-mode';
import {
  ACL_VERDICTS,
  aclIsPrivate,
  parseAcls,
  pathsArePrivate,
  readAcls,
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
  const [reset, icacls] = calls.filter((call) =>
    call.file.endsWith('icacls.exe'),
  );
  assert.deepEqual(reset!.args, ['C:\\Users\\ana\\.gyblos', '/reset', '/Q']);
  assert.deepEqual(icacls!.args, [
    'C:\\Users\\ana\\.gyblos',
    '/inheritance:r',
    '/grant:r',
    `*${SID}:(OI)(CI)F`,
    `*${WINDOWS_SIDS.system}:(OI)(CI)F`,
    `*${WINDOWS_SIDS.administrators}:(OI)(CI)F`,
  ]);
});

void test('windows acl: paths reach PowerShell in its environment, and each item parses', async () => {
  const paths = [
    "C:\\Users\\ana\\.gyblos'; Remove-Item C:\\ -Recurse #",
    'C:\\Users\\ana\\.gyblos\\seller\\node.key',
  ];
  const fake = tools({
    'powershell.exe': `item 0\r\nowner ${SID}\r\nrule ${SID} Allow\r\nrule S-1-1-0 Deny\r\nitem 1\r\nowner ${SID}\r\n`,
  });
  assert.deepEqual(await readAcls(paths, fake.fake), [
    {
      owner: SID,
      rules: [
        { sid: SID, type: 'Allow' },
        { sid: 'S-1-1-0', type: 'Deny' },
      ],
    },
    { owner: SID, rules: [] },
  ]);
  const call = fake.calls[0]!;
  assert.deepEqual(call.env, {
    GYBLOS_ACL_PATHS: paths.join('\n'),
    PSModulePath: '',
  });
  assert.ok(!call.args.some((argument) => argument.includes('Remove-Item')));
  // A missing item or owner is unreadable, never private.
  assert.throws(() => parseAcls(`item 0\nowner ${SID}`, 2));
  assert.throws(() => parseAcls('item 0', 1));
});

void test('windows acl: one verdict for many paths, and unreadable is its own answer', async () => {
  const whoami = `"DESKTOP\\ana","${SID}"`;
  const run = (powershell: string) =>
    pathsArePrivate(
      ['C:\\a', 'C:\\a\\b'],
      tools({ 'whoami.exe': whoami, 'powershell.exe': powershell }).fake,
    );
  const own = `owner ${SID}\nrule ${SID} Allow`;
  assert.equal(
    await run(`item 0\n${own}\nitem 1\n${own}`),
    ACL_VERDICTS.PRIVATE,
  );
  assert.equal(
    await run(`item 0\n${own}\nitem 1\n${own}\nrule S-1-5-11 Allow`),
    ACL_VERDICTS.EXPOSED,
  );
  assert.equal(await run(''), ACL_VERDICTS.UNREADABLE);
  const blocked: AclTools = { run: () => Promise.reject(new Error('blocked')) };
  assert.equal(
    await pathsArePrivate(['C:\\a'], blocked),
    ACL_VERDICTS.UNREADABLE,
  );
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
  assert.equal(
    aclIsPrivate({ owner: WINDOWS_SIDS.administrators, rules }, SID),
    true,
  );
});

void test('mode bits decide privacy on POSIX only; the public sequence never judged the owner', () => {
  const loose = { mode: 0o100666, uid: 0 };
  const strangers = { mode: 0o100600, uid: (process.getuid?.() ?? 0) + 1 };
  assert.equal(
    hasPrivateMode(strangers, 0o600, { platform: 'linux' }),
    !process.getuid,
  );
  assert.equal(
    hasPrivateMode(strangers, 0o600, { platform: 'linux', owner: false }),
    true,
  );
  assert.equal(hasPrivateMode(loose, 0o600, { platform: 'win32' }), true);
  assert.equal(hasPrivateMode(loose, 0o600, { platform: 'linux' }), false);
});
