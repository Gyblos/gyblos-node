// Read-only bounded snapshots of private diagnostic slots; follow never creates files or profiles.
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { FILE_MODES, PRIVATE_LOG_LIMITS } from '@gyblos/config';

import {
  DIAGNOSTIC_FORMAT,
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_READ_ERROR,
  type DiagnosticLevel,
} from './constants';
import { diagnosticRecord } from './diagnostic-record';
import type { DiagnosticRecord, DiagnosticSink } from './diagnostics';
import { checkPrivateDirectory } from './private-file';
import { hasPrivateMode } from './private-mode';

export interface DiagnosticFilter {
  level?: DiagnosticLevel;
  component?: string;
  operation?: string;
  correlationId?: string;
  limit?: number;
}
function unavailable(): never {
  throw new Error(DIAGNOSTIC_READ_ERROR);
}
async function snapshot(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      !hasPrivateMode(info, FILE_MODES.privateFile) ||
      info.size > PRIVATE_LOG_LIMITS.fileBytes
    )
      return unavailable();
    const bytes = Buffer.alloc(info.size);
    let total = 0;
    while (total < bytes.length) {
      const result = await file.read(bytes, total, bytes.length - total, total);
      if (!result.bytesRead) return unavailable();
      total += result.bytesRead;
    }
    const named = await lstat(path);
    if (
      named.isSymbolicLink() ||
      named.dev !== info.dev ||
      named.ino !== info.ino ||
      named.nlink !== 1 ||
      named.size < info.size
    )
      return unavailable();
    const complete = bytes.subarray(0, bytes.lastIndexOf('\n') + 1);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(complete);
    // An append interrupted mid-record is never interpreted or printed.
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        if (Buffer.byteLength(line + '\n') > PRIVATE_LOG_LIMITS.recordBytes)
          return unavailable();
        const record = diagnosticRecord(JSON.parse(line) as unknown);
        return record ?? unavailable();
      });
  } finally {
    await file.close();
  }
}
async function records(directory: string) {
  try {
    if (!(await checkPrivateDirectory(directory))) return [];
    const handle = await opendir(directory);
    const names: string[] = [];
    let entries = 0;
    for await (const entry of handle) {
      if (
        ++entries >
        PRIVATE_LOG_LIMITS.maxFiles * DIAGNOSTIC_FORMAT.directoryEntryFactor
      )
        return unavailable();
      if (
        entry.name.startsWith(PRIVATE_LOG_LIMITS.filenamePrefix) &&
        entry.name.endsWith(PRIVATE_LOG_LIMITS.filenameSuffix)
      )
        names.push(entry.name);
    }
    if (names.length > PRIVATE_LOG_LIMITS.maxFiles) return unavailable();
    const result: DiagnosticRecord[] = [];
    for (const name of names)
      result.push(...(await snapshot(join(directory, name))));
    if (!(await checkPrivateDirectory(directory))) return unavailable();
    return result.sort(
      (earlier, later) =>
        earlier.at.localeCompare(later.at) ||
        earlier.id.localeCompare(later.id),
    );
  } catch {
    return unavailable();
  }
}
function matches(record: DiagnosticRecord, filter: DiagnosticFilter) {
  const levels = Object.values(DIAGNOSTIC_LEVELS);
  return (
    (filter.level === undefined ||
      levels.indexOf(record.level) >= levels.indexOf(filter.level)) &&
    (filter.component === undefined || record.component === filter.component) &&
    (filter.operation === undefined || record.operation === filter.operation) &&
    (filter.correlationId === undefined ||
      record.correlationId === filter.correlationId)
  );
}
function limit(filter: DiagnosticFilter) {
  const value = filter.limit ?? DIAGNOSTIC_FORMAT.defaultRecords;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DIAGNOSTIC_FORMAT.maxRecords
  )
    return unavailable();
  return value;
}
export async function readDiagnostics(
  directory: string,
  filter: DiagnosticFilter = {},
) {
  const count = limit(filter);
  return (await records(directory))
    .filter((record) => matches(record, filter))
    .slice(-count);
}
export async function followDiagnostics(
  directory: string,
  sink: DiagnosticSink,
  signal: AbortSignal,
  filter: DiagnosticFilter = {},
) {
  const count = limit(filter);
  let seen: Set<string> | undefined;
  while (!signal.aborted) {
    const current = await records(directory);
    const selected = current.filter(
      (record) => !seen?.has(record.id) && matches(record, filter),
    );
    for (const record of seen ? selected : selected.slice(-count)) {
      if (signal.aborted) return;
      sink(record);
    }
    seen = new Set(current.map((record) => record.id));
    try {
      await setTimeout(DIAGNOSTIC_FORMAT.followMs, undefined, { signal });
    } catch {
      if (!signal.aborted) return unavailable();
    }
  }
}
