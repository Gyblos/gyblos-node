// Windows has no mode bits, so a role's privacy there is its folders' and keys' ACLs (windows-acl.ts).
// Elsewhere both helpers do nothing.
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { WINDOWS } from '@gyblos/runtime/private-mode';
import {
  ACL_VERDICTS,
  pathsArePrivate,
  restrictDirectory,
  restrictTree,
} from '@gyblos/runtime/windows-acl';

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// Called before setup writes anything: an existing role folder (and the keys' own permissions) is
// restricted again at once, so rerunning setup repairs it. The returned step restricts the folder setup
// creates, and the home only when setup creates it, never a folder chosen as GYBLOS_HOME others may use.
export async function windowsRoleAccess(roleDirectory: string) {
  if (!WINDOWS) return async () => {};
  const createdHome = !(await exists(dirname(roleDirectory)));
  if (await exists(roleDirectory)) await restrictTree(roleDirectory);
  return async () => {
    if (createdHome) await restrictDirectory(dirname(roleDirectory));
    await restrictTree(roleDirectory);
  };
}

// The home (with seller.env), the keys' folder and every key keep everyone else out.
export async function windowsKeysPrivate(
  home: string,
  keys: readonly string[],
) {
  if (!WINDOWS || keys.length === 0) return true;
  return (
    (await pathsArePrivate([home, dirname(keys[0]!), ...keys])) ===
    ACL_VERDICTS.PRIVATE
  );
}
