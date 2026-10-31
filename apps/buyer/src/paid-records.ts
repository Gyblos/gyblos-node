// The paid buyer's outcome records: one JSON line per request that reached a seller and did not settle
// as the buyer counted, appended to a private file in the buyer home for reconciliation. Records hold
// identifiers and amounts only; a full file refuses new records rather than growing without bound.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { FILE_MODES } from '@gyblos/config';

import { PAID_BUYER } from './constants';
import type { PaidBuyerRecord } from './paid-execution';

export function paidRecords(path: string) {
  return {
    async record(record: PaidBuyerRecord): Promise<void> {
      const line = `${JSON.stringify({
        nodeId: record.nodeId,
        requestDigest: record.requestDigest,
        channelId: record.channelId,
        verdict: record.verdict,
        expectedAtomic: record.expectedAtomic,
        claimedAtomic: record.claimedAtomic,
      })}\n`;
      // Never through a link planted in the home, and never blocking on a FIFO.
      const file = await open(
        path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        FILE_MODES.privateFile,
      );
      try {
        const found = await file.stat();
        // A regular file with no other name (no hard link elsewhere), kept private.
        if (!found.isFile() || found.nlink !== 1)
          throw new Error('paid records unsafe');
        if (found.size + Buffer.byteLength(line) > PAID_BUYER.recordsBytes)
          throw new Error('paid records full');
        await file.chmod(FILE_MODES.privateFile);
        await file.appendFile(line);
        await file.datasync();
      } finally {
        await file.close();
      }
    },
  };
}
