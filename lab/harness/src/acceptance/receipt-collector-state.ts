// Inspects only lab-owned snapshots using bounded private reads and existing receipt verification.
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { FILE_MODES } from '@gyblos/config';
import { prepareCollectedReceipt } from '@gyblos/core/receipt-collector';
import { canonicalJson } from '@gyblos/protocol';
import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { readPrivateFile } from '@gyblos/runtime/private-file';
import {
  RECEIPT_FILE_FORMAT,
  RECEIPT_FILE_LIMITS,
} from '@gyblos/telemetry-file/receipt-store';

import { ACCEPTANCE } from './constants';
import { acceptanceAssert } from './errors';
import { COLLECTOR_ACCEPTANCE } from './receipt-collector-constants';
import { assertAcceptanceTempBase } from './workspace';

export const collectorBytes = (value: unknown) =>
  new TextEncoder().encode(canonicalJson(value));
export async function collectorPath(root: string) {
  assertAcceptanceTempBase(root);
  const resolved = await realpath(root);
  assertAcceptanceTempBase(resolved);
  acceptanceAssert(
    resolved === root && basename(root).startsWith(ACCEPTANCE.temporaryPrefix),
  );
  return join(
    root,
    COLLECTOR_ACCEPTANCE.directory,
    COLLECTOR_ACCEPTANCE.snapshot,
  );
}
export async function collectorSnapshot(path: string) {
  const text = await readPrivateFile(path, RECEIPT_FILE_LIMITS.bytes);
  acceptanceAssert(text);
  const directory = await stat(dirname(path));
  acceptanceAssert(
    (directory.mode & FILE_MODES.permissionMask) ===
      FILE_MODES.privateDirectory,
  );
  const value: unknown = JSON.parse(text);
  const snapshot = controlObject(value, ['version', 'entries']);
  acceptanceAssert(
    snapshot.version === RECEIPT_FILE_FORMAT.version &&
      canonicalJson(value) + '\n' === text,
  );
  const entries = [];
  for (const raw of controlArray(
    snapshot.entries,
    RECEIPT_FILE_LIMITS.entries,
  )) {
    const row = controlObject(raw, ['key', 'fingerprint', 'receipt']);
    const verified = await prepareCollectedReceipt(collectorBytes(row.receipt));
    acceptanceAssert(
      row.key === verified.key && row.fingerprint === verified.fingerprint,
    );
    entries.push(verified);
  }
  acceptanceAssert(
    new Set(entries.map((entry) => entry.key)).size === entries.length,
  );
  return { text, entries };
}
