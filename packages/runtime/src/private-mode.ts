// "Owner-only" as each platform can see it. On POSIX: the exact mode bits and this process's uid. Windows
// has neither (NTFS reports 0o666 and uid 0, and chmod only toggles read-only), so there a private
// directory's ACL is restricted when created and checked before keys are read (windows-acl.ts); these
// per-file checks then only refuse what Windows can show: links, other file types and extra hard links.
import { FILE_MODES } from '@gyblos/config';

export const WINDOWS = process.platform === 'win32';

export interface PrivateModeOptions {
  // Whether this process's uid must own it too (every caller but the public sequence, which never did).
  owner?: boolean;
  platform?: NodeJS.Platform;
}

export function hasPrivateMode(
  info: { mode: number | bigint; uid: number | bigint },
  expected: number,
  { owner = true, platform = process.platform }: PrivateModeOptions = {},
) {
  if (platform === 'win32') return true;
  return (
    (Number(info.mode) & FILE_MODES.permissionMask) === expected &&
    (!owner || !process.getuid || Number(info.uid) === process.getuid())
  );
}
