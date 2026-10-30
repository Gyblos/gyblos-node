// Owner-only state files: directories created without symlinked components, bounded no-follow reads
// that refuse special files, atomic durable writes (temp, fsync, rename, directory fsync), and a
// process lock held for the owner's lifetime that only a dead owner on this host can lose. The lock
// assumes one host and one pid namespace with a stable hostname; a lock it cannot judge (another
// host, a file left unreadable by a crash mid-create) is refused until removed by hand.
// Every failure is PrivateFileError with a static code. On macOS fsync does not flush the drive
// cache (no F_FULLFSYNC from Node), so a power loss can still drop the last acknowledged write.
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';

import { FILE_MODES } from '@gyblos/config';

import { PRIVATE_FILE_CODES, PROCESS_LOCK } from './constants';

export class PrivateFileError extends Error {
  readonly code = PRIVATE_FILE_CODES.UNAVAILABLE;
  constructor() {
    super(PRIVATE_FILE_CODES.UNAVAILABLE);
    this.name = 'PrivateFileError';
  }
}

function fail(): never {
  throw new PrivateFileError();
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    return fail();
  }
}

function owned(info: Stats, mode: number) {
  if (
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & FILE_MODES.permissionMask) !== mode
  )
    fail();
}

const NEW_FILE =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

// Every component is a real directory (never a user-made symlink); the last one is owner-only.
export function ensurePrivateDirectory(path: string): Promise<void> {
  return guarded(async () => {
    const absolute = resolve(path);
    let current = parse(absolute).root;
    for (const part of absolute
      .slice(current.length)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, part);
      try {
        await mkdir(current, { mode: FILE_MODES.privateDirectory });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const info = await lstat(current);
      // Only the system's own links (macOS /var, /tmp) are followed; any other link is refused.
      if (info.isSymbolicLink()) {
        if (info.uid !== 0 || current === absolute) fail();
        if (!(await stat(current)).isDirectory()) fail();
        continue;
      }
      if (!info.isDirectory()) fail();
      if (current === absolute) owned(info, FILE_MODES.privateDirectory);
    }
  });
}

// The handle still names `path` (same device and inode), is a single-link regular file and is owned.
async function sameFile(file: FileHandle, path: string, maxBytes: number) {
  const opened = await file.stat();
  const named = await lstat(path);
  if (
    named.isSymbolicLink() ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    !opened.isFile() ||
    opened.nlink !== 1 ||
    opened.size > maxBytes
  )
    fail();
  owned(opened, FILE_MODES.privateFile);
  return opened;
}

export function readPrivateFile(
  path: string,
  maxBytes: number,
): Promise<string | undefined> {
  return guarded(async () => {
    let file: FileHandle;
    try {
      file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const info = await sameFile(file, path, maxBytes);
      // One byte of room past the size seen, so a file that grew is caught rather than cut.
      const bytes = Buffer.alloc(info.size + 1);
      let total = 0;
      let bytesRead: number;
      do {
        ({ bytesRead } = await file.read(
          bytes,
          total,
          bytes.length - total,
          total,
        ));
        total += bytesRead;
      } while (bytesRead > 0 && total < bytes.length);
      if (total !== info.size) fail();
      return new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, total),
      );
    } finally {
      await file.close();
    }
  });
}

export function writePrivateFile(
  path: string,
  text: string,
  maxBytes: number,
): Promise<void> {
  return guarded(async () => {
    if (Buffer.byteLength(text) > maxBytes) fail();
    const parent = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      owned(await parent.stat(), FILE_MODES.privateDirectory);
      const file = await open(temporary, NEW_FILE, FILE_MODES.privateFile);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      const before = await parent.stat();
      const named = await lstat(dirname(path));
      if (before.dev !== named.dev || before.ino !== named.ino) fail();
      await rename(temporary, path);
      if (process.platform !== 'win32') await parent.sync();
    } finally {
      await unlink(temporary).catch(() => {});
      await parent.close();
    }
  });
}

export interface ProcessLock {
  // Fails if the lock file at the path is no longer the one this process holds.
  verify(): Promise<void>;
  release(): Promise<void>;
}

interface LockOwner {
  pid: number;
  host: string;
}

// Lock paths this process holds or is acquiring, so its own pid in a lock file it does not hold
// (an earlier run that reused the pid, such as pid 1 in a restarted container) reads as stale.
const HELD = new Set<string>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function stale(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  return owner.pid === process.pid || !alive(owner.pid);
}
async function ownerAt(path: string): Promise<LockOwner | undefined> {
  const text = await readPrivateFile(path, PROCESS_LOCK.maxBytes);
  if (text === undefined) return undefined;
  const owner: unknown = JSON.parse(text);
  if (
    owner &&
    typeof owner === 'object' &&
    'pid' in owner &&
    'host' in owner &&
    Number.isSafeInteger(owner.pid) &&
    typeof owner.host === 'string'
  )
    return { pid: Number(owner.pid), host: owner.host };
  return fail();
}

// Replaces a dead owner's lock. Takeovers are serialized by an exclusive guard file, and the file
// moved aside must be the one judged dead, so a fresh lock is never removed; anything else, and a
// guard left by a crash mid-takeover, is refused until removed by hand.
async function takeOver(path: string): Promise<FileHandle | undefined> {
  const guard = await open(
    `${path}${PROCESS_LOCK.guardSuffix}`,
    NEW_FILE,
    FILE_MODES.privateFile,
  );
  try {
    const inspected = await lstat(path);
    const owner = await ownerAt(path);
    if (!owner || !stale(owner)) fail();
    const aside = `${path}.${randomUUID()}.stale`;
    await rename(path, aside);
    const moved = await lstat(aside);
    if (moved.dev !== inspected.dev || moved.ino !== inspected.ino) {
      await link(aside, path).catch(() => {});
      await unlink(aside);
      fail();
    }
    await unlink(aside);
    return await create(path);
  } finally {
    await guard.close();
    await unlink(`${path}${PROCESS_LOCK.guardSuffix}`);
  }
}

async function create(path: string): Promise<FileHandle | undefined> {
  let file: FileHandle;
  try {
    file = await open(path, NEW_FILE, FILE_MODES.privateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    await file.writeFile(
      JSON.stringify({ pid: process.pid, host: hostname() }),
    );
    await file.sync();
    return file;
  } catch (error) {
    await file.close();
    await unlink(path).catch(() => {});
    throw error;
  }
}

export function acquireProcessLock(path: string): Promise<ProcessLock> {
  const key = resolve(path);
  if (HELD.has(key)) return guarded(async () => fail());
  // Reserved before any await, so two acquisitions in this process never both proceed.
  HELD.add(key);
  return guarded(async () => {
    const file = (await create(path)) ?? (await takeOver(path));
    if (!file) return fail();
    const verify = () =>
      guarded(async () => {
        await sameFile(file, path, PROCESS_LOCK.maxBytes);
      });
    try {
      await verify();
    } catch (error) {
      await file.close();
      throw error;
    }
    return {
      verify,
      release: () =>
        guarded(async () => {
          try {
            await sameFile(file, path, PROCESS_LOCK.maxBytes);
            await unlink(path);
          } finally {
            HELD.delete(key);
            await file.close();
          }
        }),
    };
  }).catch((error: unknown) => {
    HELD.delete(key);
    throw error;
  });
}
