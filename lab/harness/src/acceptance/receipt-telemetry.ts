// Inspects only the isolated scenario's local logs after shutdown; reports no event content or identities.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FILE_MODES,
  PRIVATE_LOG_LIMITS,
  ROLE_FILES,
  rolePathIn,
  type HomeEnvironment,
} from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { controlObject } from '@gyblos/protocol/control-validation';
import { TELEMETRY_EVENTS } from '@gyblos/protocol/telemetry';

import { acceptanceAssert } from './errors';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';

export async function receiptTelemetry(
  environment: HomeEnvironment,
  answers: number,
) {
  for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER]) {
    const directory = rolePathIn(environment, role, ROLE_FILES.telemetry);
    const info = await lstat(directory);
    acceptanceAssert(
      info.isDirectory() &&
        (info.mode & FILE_MODES.permissionMask) === FILE_MODES.privateDirectory,
    );
    const names = await readdir(directory);
    acceptanceAssert(
      names.length > 0 && names.length <= PRIVATE_LOG_LIMITS.maxFiles,
    );
    const counts = new Map<string, { received: number; terminal: number }>();
    let completed = 0;
    let failed = 0;
    let first = 0;
    for (const name of names) {
      acceptanceAssert(
        name.startsWith(PRIVATE_LOG_LIMITS.filenamePrefix) &&
          name.endsWith(PRIVATE_LOG_LIMITS.filenameSuffix),
      );
      const path = join(directory, name);
      const file = await lstat(path);
      acceptanceAssert(
        file.isFile() &&
          file.size <= PRIVATE_LOG_LIMITS.fileBytes &&
          (file.mode & FILE_MODES.permissionMask) === FILE_MODES.privateFile,
      );
      const text = await readFile(path, 'utf8');
      acceptanceAssert(
        !text.includes(RECEIPT_ACCEPTANCE.text) &&
          !text.includes('synthetic acceptance input') &&
          !text.includes(RECEIPT_ACCEPTANCE.engineOrigin),
      );
      for (const line of text.trim().split('\n')) {
        acceptanceAssert(
          Buffer.byteLength(line + '\n') <= PRIVATE_LOG_LIMITS.recordBytes,
        );
        const value: unknown = JSON.parse(line);
        acceptanceAssert(
          value && typeof value === 'object' && !Array.isArray(value),
        );
        const allowed = [
          'type',
          'at',
          'role',
          'buyerNodeId',
          'sellerNodeId',
          'selection',
          'engineKind',
          'streaming',
          'meteringMode',
          'requestId',
          'usage',
          'sizes',
          'totalMs',
          'finishReason',
          'code',
          'reason',
          'delivered',
          'refusal',
          'firstTokenMs',
        ];
        const keys = Object.keys(value);
        acceptanceAssert(keys.every((key) => allowed.includes(key)));
        const event = controlObject(value, keys);
        acceptanceAssert(
          event.role === role && typeof event.requestId === 'string',
        );
        const row = counts.get(event.requestId) ?? { received: 0, terminal: 0 };
        if (event.type === TELEMETRY_EVENTS.REQUEST_RECEIVED) row.received++;
        if (
          [
            TELEMETRY_EVENTS.COMPLETED,
            TELEMETRY_EVENTS.FAILED,
            TELEMETRY_EVENTS.REFUSED,
          ].some((type) => type === event.type)
        )
          row.terminal++;
        if (event.type === TELEMETRY_EVENTS.COMPLETED) completed++;
        if (event.type === TELEMETRY_EVENTS.FAILED) failed++;
        if (event.type === TELEMETRY_EVENTS.FIRST_TOKEN) first++;
        counts.set(event.requestId, row);
      }
    }
    acceptanceAssert(completed === answers && failed === 2 && first > 0);
    acceptanceAssert(
      [...counts.values()].every(
        (row) => row.received === 1 && row.terminal === 1,
      ),
    );
  }
}
