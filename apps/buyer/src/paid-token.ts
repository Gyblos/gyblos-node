// The paid endpoint's bearer token: loopback is not authentication, and each paid request can spend up
// to maxAtomic. A private file in the buyer home, created whole on the first paid start, never logged
// or echoed; an unsafe file is refused rather than repaired, since its token may already have been read.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';

import { FILE_MODES } from '@gyblos/config';
import { readPrivateFile } from '@gyblos/runtime/private-file';

import { PAID_BUYER } from './constants';

const TOKEN = new RegExp(`^[A-Za-z0-9_-]{${PAID_BUYER.tokenChars}}$`);

// A regular private file with one name, this user's; undefined when there is none.
async function readToken(path: string) {
  const text = await readPrivateFile(path, PAID_BUYER.tokenFileBytes);
  if (text === undefined) return undefined;
  const token = text.trimEnd();
  if (!TOKEN.test(token)) throw new Error('paid token invalid');
  return token;
}

// Written whole to a temporary name, then linked into place: the link fails if another start got
// there first, and a crash never leaves a partial token under the real name.
async function createToken(path: string) {
  const token = randomBytes(PAID_BUYER.tokenBytes).toString('base64url');
  const staged = `${path}.${randomBytes(PAID_BUYER.stagedSuffixBytes).toString('hex')}.tmp`;
  const file = await open(
    staged,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    FILE_MODES.privateFile,
  );
  try {
    try {
      await file.writeFile(token);
      await file.datasync();
    } finally {
      await file.close();
    }
    await link(staged, path);
    return token;
  } finally {
    await unlink(staged);
  }
}

// The token in the home, or a new one when there is none yet; throws when the file is unsafe or invalid.
export async function paidToken(path: string): Promise<string> {
  const found = await readToken(path);
  if (found !== undefined) return found;
  try {
    return await createToken(path);
  } catch (error) {
    // Another start created it first.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const created = await readToken(path);
    if (created === undefined) throw error;
    return created;
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
