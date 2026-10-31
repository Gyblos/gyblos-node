// The paid endpoint's bearer token: loopback keeps browsers out but not other local processes or users,
// and each paid request can spend up to maxAtomic. The token lives in a private file in the buyer home,
// created on the first paid start; it is never logged or echoed, and a file that is not safely private
// is refused rather than repaired, since its token may already have been read.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';

import { FILE_MODES } from '@gyblos/config';

import { PAID_BUYER } from './constants';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Never through a link planted in the home, and never blocking on a FIFO.
const SAFE_OPEN = constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function readToken(path: string) {
  const file = await open(path, constants.O_RDONLY | SAFE_OPEN);
  try {
    const found = await file.stat();
    // A regular file with no other name, this user's, open to no one else.
    if (
      !found.isFile() ||
      found.nlink !== 1 ||
      (found.mode & FILE_MODES.permissionMask & ~FILE_MODES.privateFile) !==
        0 ||
      (process.getuid !== undefined && found.uid !== process.getuid())
    )
      throw new Error('paid token unsafe');
    if (found.size > PAID_BUYER.tokenFileBytes)
      throw new Error('paid token invalid');
    const token = (await file.readFile('utf8')).trimEnd();
    if (!TOKEN.test(token)) throw new Error('paid token invalid');
    return token;
  } finally {
    await file.close();
  }
}

async function createToken(path: string) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | SAFE_OPEN,
    FILE_MODES.privateFile,
  );
  try {
    const token = randomBytes(PAID_BUYER.tokenBytes).toString('base64url');
    await file.writeFile(token);
    await file.datasync();
    return token;
  } finally {
    await file.close();
  }
}

// The token in the home, or a new one when there is none yet; throws when the file is unsafe or invalid.
export async function paidToken(path: string): Promise<string> {
  try {
    return await readToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    return await createToken(path);
  } catch (error) {
    // Another start created it first.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return readToken(path);
    throw error;
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

// True only for `Authorization: Bearer <token>`; digests compare in constant time whatever the length.
export function bearerAuthorizer(token: string) {
  const expected = digest(token);
  return (request: IncomingMessage) => {
    const header = request.headers.authorization ?? '';
    const space = header.indexOf(' ');
    const scheme = space < 0 ? '' : header.slice(0, space);
    const presented = space < 0 ? '' : header.slice(space + 1);
    const matches = timingSafeEqual(digest(presented), expected);
    return (
      scheme.toLowerCase() === PAID_BUYER.authScheme.toLowerCase() && matches
    );
  };
}
