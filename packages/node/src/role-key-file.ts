// Reads a role's private key file: opened once without following a link, checked on that descriptor
// (regular file, mode 0600, this user, bounded size) and read from it, then parsed as exactly `length`
// bytes. Key contents never appear in errors.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { FILE_MODES, KEY_LIMITS } from '@gyblos/config';

// A regular, non-symlinked file owned by this user with mode 0600; checked from metadata only.
export function privateKeyMetadata(
  metadata: Pick<
    Awaited<ReturnType<typeof lstat>>,
    'isFile' | 'isSymbolicLink' | 'mode' | 'uid'
  >,
) {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    (Number(metadata.mode) & FILE_MODES.permissionMask) ===
      FILE_MODES.privateFile &&
    (!process.getuid || Number(metadata.uid) === process.getuid())
  );
}

// Opened once without following a link (non-blocking, so a FIFO cannot stall it), checked on that
// descriptor and read from it: the path cannot be swapped between the check and the read.
async function privateKeyText(path: string) {
  const invalid = () => new Error('Role key permissions or owner are invalid.');
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw invalid();
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!privateKeyMetadata(metadata)) throw invalid();
    if (metadata.size > KEY_LIMITS.fileBytes)
      throw new Error('Invalid role key.');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function privateBytes(path: string, length: number) {
  let value: unknown;
  try {
    value = JSON.parse(await privateKeyText(path));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid role key.');
    throw error;
  }
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some(
      (byte) =>
        !Number.isInteger(byte) || byte < 0 || byte > KEY_LIMITS.byteMax,
    )
  )
    throw new Error('Invalid role key.');
  return Uint8Array.from(value);
}
