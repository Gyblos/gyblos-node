// Reclaims the oldest settled journal slot and stale quarantines, removing only private single-link
// files owned by this uid that are not held open.
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { FILE_MODES, PRIVATE_LOG_LIMITS } from '@gyblos/config';

const PERMISSION_BITS =
  constants.S_IRWXU | constants.S_IRWXG | constants.S_IRWXO;

export interface ReclaimPolicy {
  directory: string;
  slotNames: readonly string[];
  minAgeMs: number;
  isOpen(info: Stats): boolean;
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function sameInode(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino;
}

// Size and mtime also guard against immediate inode-number reuse.
function sameJournal(left: Stats, right: Stats) {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

// Only single-link, private, regular files owned by this uid are ever removed.
function ownedPrivateFile(info: Stats, policy: ReclaimPolicy) {
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.nlink === 1 &&
    (!process.getuid || info.uid === process.getuid()) &&
    (info.mode & PERMISSION_BITS) === FILE_MODES.privateFile &&
    !policy.isOpen(info)
  );
}

// Journals age by last append (mtime); quarantines by their rename (ctime).
function settled(changedMs: number, policy: ReclaimPolicy, now: number) {
  return now - changedMs >= policy.minAgeMs;
}

function quarantineName(name: string) {
  return (
    name.startsWith(
      PRIVATE_LOG_LIMITS.filenamePrefix + PRIVATE_LOG_LIMITS.quarantineInfix,
    ) && name.endsWith(PRIVATE_LOG_LIMITS.quarantineSuffix)
  );
}

// A crash between rename and unlink leaves a uniquely named quarantine file;
// remove settled ones so leftovers cannot accumulate across restarts.
async function removeStaleQuarantines(
  names: readonly string[],
  policy: ReclaimPolicy,
  now: number,
) {
  for (const name of names.filter(quarantineName)) {
    const path = join(policy.directory, name);
    const info = await lstatIfPresent(path);
    if (
      !info ||
      !ownedPrivateFile(info, policy) ||
      !settled(info.ctimeMs, policy, now)
    )
      continue;
    const current = await lstatIfPresent(path);
    if (!current || !sameInode(current, info)) continue;
    await unlink(path).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}

// Put back an inode that changed under us without clobbering a newer slot.
async function restore(quarantine: string, original: string) {
  try {
    await link(quarantine, original);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  await unlink(quarantine);
}

/**
 * Removes the least recently modified reclaimable slot file. Returns true when
 * a slot may now be free (removed here or vanished concurrently) and false when
 * nothing may safely be removed, so callers fail closed.
 */
export async function reclaimOldestSlot(policy: ReclaimPolicy) {
  const names = await readdir(policy.directory);
  const now = Date.now();
  await removeStaleQuarantines(names, policy, now);
  const candidates: { name: string; info: Stats }[] = [];
  for (const name of names) {
    if (!policy.slotNames.includes(name)) continue;
    const info = await lstatIfPresent(join(policy.directory, name));
    if (
      info &&
      ownedPrivateFile(info, policy) &&
      settled(info.mtimeMs, policy, now)
    )
      candidates.push({ name, info });
  }
  candidates.sort(
    (left, right) =>
      left.info.mtimeMs - right.info.mtimeMs ||
      (left.name < right.name ? -1 : 1),
  );
  const oldest = candidates[0];
  if (!oldest) return false;
  const original = join(policy.directory, oldest.name);
  const current = await lstatIfPresent(original);
  if (!current) return true;
  if (!sameJournal(current, oldest.info) || !ownedPrivateFile(current, policy))
    return false;
  // rename is atomic: of two concurrent reclaimers only one moves this name.
  const quarantine = join(
    policy.directory,
    PRIVATE_LOG_LIMITS.filenamePrefix +
      PRIVATE_LOG_LIMITS.quarantineInfix +
      randomUUID() +
      PRIVATE_LOG_LIMITS.quarantineSuffix,
  );
  try {
    await rename(original, quarantine);
  } catch (error) {
    if (missing(error)) return true;
    throw error;
  }
  const moved = await lstat(quarantine);
  if (!sameJournal(moved, oldest.info) || !ownedPrivateFile(moved, policy)) {
    await restore(quarantine, original);
    return false;
  }
  await unlink(quarantine);
  return true;
}
