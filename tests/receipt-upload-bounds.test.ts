// Rejects wide malformed receipts with bounded parser work before upload authentication.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  P2P_ROLES,
  RECEIPT,
} from '@gyblos/protocol/constants';
import {
  RECEIPT_UPLOAD,
  verifyReceiptUpload,
} from '@gyblos/protocol/receipt-upload';
import { RECEIPT_V2 } from '@gyblos/protocol/receipt-v2';

import {
  receiptParserWork,
  wideReceiptRecord,
} from './support/receipt-parser-work';
import {
  freePair,
  paidPair,
  rejects,
  sellerUpload,
} from './support/receipt-upload';

for (const version of [RECEIPT.version, RECEIPT_V2.version]) {
  for (const side of Object.values(P2P_ROLES)) {
    void test(`receipt upload rejects wide v${version} ${side} records with linear work`, async (t) => {
      const pair =
        version === RECEIPT.version ? await freePair() : await paidPair();
      const half = pair.receipt[side];
      assert.ok(half);
      const record = wideReceiptRecord(half.record);
      const receipt = {
        ...pair.receipt,
        [side]: { ...half, record },
      };
      const upload = sellerUpload(pair.seller.nodeId, pair.receipt);
      const signed = {
        upload: {
          ...upload,
          items: [{ ...upload.items[0]!, receipt }],
        },
        signature: '00'.repeat(CONTROL_LIMITS.signatureBytes),
      };
      assert.ok(
        Buffer.byteLength(JSON.stringify(signed)) < RECEIPT_UPLOAD.maxBytes,
      );
      const linearWork = receiptParserWork(t, record);
      const verify = t.mock.method(crypto.subtle, 'verify');
      await rejects(verifyReceiptUpload(signed), CONTROL_CODES.INVALID);
      assert.equal(verify.mock.callCount(), 0);
      linearWork();
    });
  }
}
