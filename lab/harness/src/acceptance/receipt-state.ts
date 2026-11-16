// Inspects only owned temporary receipt snapshots, independently verifying signatures and cross-role persistence.
import { readFile, stat } from 'node:fs/promises';

import {
  FILE_MODES,
  receiptPathsIn,
  type HomeEnvironment,
} from '@gyblos/config';
import { RECEIPT_STORAGE, RECEIPT_UPLOAD } from '@gyblos/node/constants';
import { listReceipts, openReceiptStore } from '@gyblos/node/receipts';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { controlHex, controlObject } from '@gyblos/protocol/control-validation';
import { verifyReceipt, type ReceiptV1 } from '@gyblos/protocol/receipt';

import { acceptanceAssert } from './errors';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';

export async function receiptSnapshot(
  environment: HomeEnvironment,
  role: typeof P2P_ROLES.BUYER | typeof P2P_ROLES.SELLER,
) {
  const paths = receiptPathsIn(environment, role);
  const info = await stat(paths.state);
  acceptanceAssert(info.size <= RECEIPT_UPLOAD.maxLogBytes);
  acceptanceAssert(
    (info.mode & FILE_MODES.permissionMask) === FILE_MODES.privateFile,
  );
  acceptanceAssert(
    ((await stat(paths.directory)).mode & FILE_MODES.permissionMask) ===
      FILE_MODES.privateDirectory,
  );
  const text = await readFile(paths.state, 'utf8');
  acceptanceAssert(
    !text.includes(RECEIPT_ACCEPTANCE.text) &&
      !text.includes('synthetic acceptance input'),
  );
  const input = controlObject(JSON.parse(text.slice(0, text.indexOf('\n'))), [
    'schemaVersion',
    'role',
    'nodeId',
    'entries',
    'rejectedWrites',
  ]);
  acceptanceAssert(
    input.role === role && input.schemaVersion === RECEIPT_UPLOAD.schemaVersion,
  );
  const records: ReceiptV1[] = [];
  for (const row of await listReceipts({
    environment,
    role,
    nodeId: controlHex(input.nodeId),
  }))
    records.push(await verifyReceipt(row.receipt));
  return records;
}
export async function confirmedSnapshots(environment: HomeEnvironment) {
  const seller = await receiptSnapshot(environment, P2P_ROLES.SELLER);
  const buyer = await receiptSnapshot(environment, P2P_ROLES.BUYER);
  const confirmed = seller.filter((value) => value.buyer);
  acceptanceAssert(confirmed.length === buyer.length && confirmed.length > 0);
  for (const receipt of buyer) {
    acceptanceAssert(receipt.buyer);
    acceptanceAssert(
      receipt.buyer.record.observed.inputTokens === null &&
        receipt.buyer.record.observed.outputTokens === null,
    );
    acceptanceAssert(
      confirmed.some(
        (value) => JSON.stringify(value) === JSON.stringify(receipt),
      ),
    );
  }
  return confirmed;
}
export async function receiptRetention(
  environment: HomeEnvironment,
  receipt: ReceiptV1,
) {
  const key = {
    executionRequestId: receipt.seller.record.requestId,
    requestDigest: receipt.seller.record.requestDigest,
    buyerNodeId: receipt.seller.record.buyerNodeId,
    sellerNodeId: receipt.seller.record.sellerNodeId,
  };
  for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER]) {
    const nodeId =
      role === P2P_ROLES.BUYER ? key.buyerNodeId : key.sellerNodeId;
    const options = { environment, role, nodeId };
    const expired = openReceiptStore({
      ...options,
      now: () => Date.now() + RECEIPT_STORAGE.retentionMs,
    });
    acceptanceAssert(
      (await expired.load(key, new AbortController().signal)) !== undefined,
    );
    const retained = (await receiptSnapshot(environment, role)).length;
    await openReceiptStore({ ...options, maxEntries: 1 }).put(receipt);
    acceptanceAssert(
      (await receiptSnapshot(environment, role)).length === retained,
    );
  }
}
