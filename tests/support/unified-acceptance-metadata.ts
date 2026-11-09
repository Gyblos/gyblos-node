// Verifies only the owned acceptance home's metadata files after shutdown; never returns content or identities.
import assert from 'node:assert/strict';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FILE_MODES,
  PRIVATE_LOG_LIMITS,
  receiptPathsIn,
  ROLE_FILES,
  rolePathIn,
} from '@gyblos/config';
import { listReceipts } from '@gyblos/node/receipts';
import { P2P_ROLES, type P2PRole } from '@gyblos/protocol/constants';
import { controlObject } from '@gyblos/protocol/control-validation';
import type { ReceiptV1, SellerReceiptV1 } from '@gyblos/protocol/receipt';
import { TELEMETRY_EVENTS } from '@gyblos/protocol/telemetry';

import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import type { PaidAcceptanceHost } from './paid-acceptance-host';

export async function confirmedFreeReceipts(
  run: PaidAcceptanceHost,
  signal?: AbortSignal,
) {
  const options = { environment: process.env };
  const buyer = await listReceipts(
    {
      ...options,
      role: P2P_ROLES.BUYER,
      nodeId: run.roles.buyer.nodeId,
    },
    signal,
  );
  const seller = await listReceipts(
    {
      ...options,
      role: P2P_ROLES.SELLER,
      nodeId: run.roles.seller.nodeId,
    },
    signal,
  );
  return buyer
    .filter(
      ({ receipt }) =>
        receipt.buyer &&
        seller.some(
          (entry) => JSON.stringify(entry.receipt) === JSON.stringify(receipt),
        ),
    )
    .map(({ receipt }) => receipt);
}

function contentFree(text: string) {
  for (const content of [
    PAID_ACCEPTANCE.text,
    PAID_ACCEPTANCE.interruptedText,
    'synthetic paid input',
  ])
    assert.equal(text.includes(content), false);
}
export async function unifiedPrivateEvidence(receipts: ReceiptV1[]) {
  let completed = 0;
  for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER]) {
    const paths = receiptPathsIn(process.env, role);
    for (const directory of [
      paths.directory,
      rolePathIn(process.env, role, ROLE_FILES.telemetry),
    ]) {
      const info = await lstat(directory);
      assert.ok(info.isDirectory());
      assert.equal(
        info.mode & FILE_MODES.permissionMask,
        FILE_MODES.privateDirectory,
      );
    }
    const snapshot = await lstat(paths.state);
    assert.ok(snapshot.isFile());
    assert.equal(
      snapshot.mode & FILE_MODES.permissionMask,
      FILE_MODES.privateFile,
    );
    contentFree(await readFile(paths.state, 'utf8'));
    const directory = rolePathIn(process.env, role, ROLE_FILES.telemetry);
    const names = await readdir(directory);
    assert.ok(names.length > 0 && names.length <= PRIVATE_LOG_LIMITS.maxFiles);
    const events: Record<string, unknown>[] = [];
    for (const name of names) {
      assert.ok(
        name.startsWith(PRIVATE_LOG_LIMITS.filenamePrefix) &&
          name.endsWith(PRIVATE_LOG_LIMITS.filenameSuffix),
      );
      const path = join(directory, name);
      const info = await lstat(path);
      assert.ok(info.isFile());
      assert.ok(info.size <= PRIVATE_LOG_LIMITS.fileBytes);
      assert.equal(
        info.mode & FILE_MODES.permissionMask,
        FILE_MODES.privateFile,
      );
      const text = await readFile(path, 'utf8');
      contentFree(text);
      for (const line of text.trim().split('\n')) {
        assert.ok(
          Buffer.byteLength(line + '\n') <= PRIVATE_LOG_LIMITS.recordBytes,
        );
        const value: unknown = JSON.parse(line);
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        const event = telemetryMetadata(value);
        assert.equal(event.role, role);
        events.push(event);
      }
    }
    for (const receipt of receipts) {
      const expected = receipt.seller.record;
      const selected = events.filter(
        (event) => event.requestId === expected.requestId,
      );
      for (const event of selected)
        assertReceiptTelemetry(event, expected, role);
      assert.equal(
        selected.filter(
          (event) => event.type === TELEMETRY_EVENTS.REQUEST_RECEIVED,
        ).length,
        1,
      );
      assert.equal(
        selected.filter((event) => event.type === TELEMETRY_EVENTS.COMPLETED)
          .length,
        1,
      );
      assert.equal(
        selected.some(
          (event) =>
            event.type === TELEMETRY_EVENTS.FAILED ||
            event.type === TELEMETRY_EVENTS.REFUSED,
        ),
        false,
      );
      completed++;
    }
  }
  return completed;
}

type ReceiptBinding = Pick<
  SellerReceiptV1,
  'requestId' | 'buyerNodeId' | 'sellerNodeId' | 'selection' | 'streaming'
>;
export function assertReceiptTelemetry(
  value: unknown,
  expected: ReceiptBinding,
  role: P2PRole,
) {
  const event = telemetryMetadata(value);
  assert.equal(event.role, role);
  assert.equal(event.requestId, expected.requestId);
  assert.equal(event.buyerNodeId, expected.buyerNodeId);
  assert.equal(event.sellerNodeId, expected.sellerNodeId);
  assert.deepEqual(event.selection, expected.selection);
  assert.equal(event.streaming, expected.streaming);
  return event;
}

function telemetryMetadata(value: unknown) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
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
    'amountAtomic',
    'feeAtomic',
    'network',
    'asset',
    'receipt',
    'path',
    'generationMs',
  ];
  const keys = Object.keys(value);
  assert.ok(keys.every((key) => allowed.includes(key)));
  return controlObject(value, keys);
}
