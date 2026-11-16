// Builds synthetic receipts and isolated role homes for upload-cursor tests; no real profiles or keys.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { receiptPathsIn } from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { signSellerReceipt } from '@gyblos/protocol/receipt';

import { receiptChannelFixture } from './receipt-channel';

export async function receiptUploadFixture() {
  const sample = await receiptChannelFixture();
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'gyb-upload-cursor-'),
  );
  let now = 1700000000100;
  const options = {
    environment: { GYBLOS_HOME: root },
    role: P2P_ROLES.SELLER,
    nodeId: sample.seller.nodeId,
    now: () => now,
    maxEntries: 1,
    maxBytes: 4096,
    retentionMs: 10,
  };
  return {
    ...sample,
    options,
    root,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    paths: receiptPathsIn(options.environment, options.role),
    next: async (n: number) => ({
      seller: await signSellerReceipt(
        {
          ...sample.record,
          requestId: n.toString(16).padStart(32, '0'),
        },
        sample.seller.sign,
      ),
    }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
