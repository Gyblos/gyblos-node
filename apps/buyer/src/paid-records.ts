// The paid buyer's outcome records: one JSON line per request that reached a seller and did not settle
// as the buyer counted, appended to a private file in the buyer home for reconciliation, and read back
// as the buyer's own expected charge per request. Records hold identifiers and amounts only.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { FILE_MODES } from '@gyblos/config';

import { PAID_BUYER } from './constants';
import type { PaidBuyerRecord } from './paid-execution';

const DIGEST = /^[0-9a-f]{64}$/;
const ATOMIC = /^(0|[1-9][0-9]{0,19})$/;

// Never through a link planted in the home, and never blocking on a FIFO; a regular file with no
// other name (no hard link elsewhere), kept private.
async function privateFile(path: string, flags: number) {
  const file = await open(
    path,
    flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    FILE_MODES.privateFile,
  );
  try {
    const found = await file.stat();
    if (!found.isFile() || found.nlink !== 1)
      throw new Error('paid records unsafe');
    if (found.size > PAID_BUYER.recordsBytes)
      throw new Error('paid records full');
    await file.chmod(FILE_MODES.privateFile);
    return { file, size: found.size };
  } catch (error) {
    await file.close();
    throw error;
  }
}

// Appends one JSON line; a file that would pass its bound refuses it rather than growing.
export async function appendPrivateLine(path: string, value: unknown) {
  const line = `${JSON.stringify(value)}\n`;
  const { file, size } = await privateFile(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
  );
  try {
    if (size + Buffer.byteLength(line) > PAID_BUYER.recordsBytes)
      throw new Error('paid records full');
    await file.appendFile(line);
    await file.datasync();
  } finally {
    await file.close();
  }
}

function parsed(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  } catch {
    return undefined;
  }
}

export function paidRecords(path: string) {
  return {
    record: (record: PaidBuyerRecord) =>
      appendPrivateLine(path, {
        nodeId: record.nodeId,
        requestDigest: record.requestDigest,
        channelId: record.channelId,
        verdict: record.verdict,
        expectedAtomic: record.expectedAtomic,
        claimedAtomic: record.claimedAtomic,
      }),
    // The buyer's own count per request, the latest record winning; lines that are not records are
    // skipped. No file means no records.
    async expectations(): Promise<Map<string, string>> {
      let text: string;
      try {
        const { file } = await privateFile(path, constants.O_RDONLY);
        try {
          text = await file.readFile('utf8');
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return new Map();
        throw error;
      }
      const expected = new Map<string, string>();
      for (const line of text.split('\n')) {
        const row = parsed(line);
        if (
          row &&
          typeof row.requestDigest === 'string' &&
          DIGEST.test(row.requestDigest) &&
          typeof row.expectedAtomic === 'string' &&
          ATOMIC.test(row.expectedAtomic)
        )
          expected.set(row.requestDigest, row.expectedAtomic);
      }
      return expected;
    },
  };
}
