// Composes collector policy and private persistence only inside disposable acceptance homes; no upload or startup wiring.
import { dirname, join } from 'node:path';

import {
  RECEIPT_COLLECTOR_CODES,
  RECEIPT_COLLECTOR_STATUSES,
} from '@gyblos/core/constants';
import {
  createPrivateReceiptCollector,
  prepareCollectedReceipt,
  ReceiptCollectorError,
} from '@gyblos/core/receipt-collector';
import type { ReceiptV1 } from '@gyblos/protocol/receipt';
import {
  createReceiptFileStore,
  openReceiptFileStore,
  RECEIPT_FILE_LIMITS,
} from '@gyblos/telemetry-file/receipt-store';

import { acceptanceAssert, assertAcceptanceActive } from './errors';
import {
  COLLECTOR_ACCEPTANCE,
  type CollectorAcceptanceReport,
} from './receipt-collector-constants';
import { restartAcceptanceCollector } from './receipt-collector-restart';
import {
  collectorBytes,
  collectorPath,
  collectorSnapshot,
} from './receipt-collector-state';

async function refuses(
  run: () => Promise<unknown>,
  code: ReceiptCollectorError['code'],
) {
  let refused = false;
  try {
    await run();
  } catch (error) {
    refused = error instanceof ReceiptCollectorError && error.code === code;
  }
  acceptanceAssert(refused);
}
async function collectorRefusals(
  path: string,
  receipts: readonly ReceiptV1[],
  signal: AbortSignal,
) {
  const bounded = join(dirname(path), COLLECTOR_ACCEPTANCE.boundedSnapshot);
  const store = await createReceiptFileStore({ path: bounded, maxEntries: 1 });
  try {
    const collector = createPrivateReceiptCollector(store);
    const first = collectorBytes(receipts[0]);
    acceptanceAssert(
      (await collector.collect(first, signal)).status ===
        RECEIPT_COLLECTOR_STATUSES.STORED,
    );
    const before = await collectorSnapshot(bounded);
    await refuses(
      () => collector.collect(collectorBytes(receipts[1]), signal),
      RECEIPT_COLLECTOR_CODES.LIMIT,
    );
    acceptanceAssert(
      (await collector.collect(first, signal)).status ===
        RECEIPT_COLLECTOR_STATUSES.DUPLICATE,
    );
    const controller = new AbortController();
    controller.abort();
    await refuses(
      () => collector.collect(first, controller.signal),
      RECEIPT_COLLECTOR_CODES.CANCELLED,
    );
    await refuses(
      () =>
        collector.collect(
          collectorBytes({ seller: receipts[0]!.seller }),
          signal,
        ),
      RECEIPT_COLLECTOR_CODES.PAIR_REQUIRED,
    );
    acceptanceAssert((await collectorSnapshot(bounded)).text === before.text);
    return COLLECTOR_ACCEPTANCE.refusals;
  } finally {
    await store.close();
  }
}
export async function collectReceiptAcceptance(
  root: string,
  receipts: readonly ReceiptV1[],
  signal: AbortSignal,
): Promise<CollectorAcceptanceReport> {
  assertAcceptanceActive(signal);
  acceptanceAssert(
    receipts.length >= 2 && receipts.length <= RECEIPT_FILE_LIMITS.entries,
  );
  const expected = [];
  for (const receipt of receipts)
    expected.push(await prepareCollectedReceipt(collectorBytes(receipt)));
  acceptanceAssert(
    new Set(expected.map((entry) => entry.key)).size === expected.length,
  );
  assertAcceptanceActive(signal);
  const path = await collectorPath(root);
  const store = await createReceiptFileStore({
    path,
    maxEntries: receipts.length,
  });
  try {
    const collector = createPrivateReceiptCollector(store);
    for (
      let index = 0;
      index < receipts.length;
      index += COLLECTOR_ACCEPTANCE.concurrency
    ) {
      const results = await Promise.all(
        receipts
          .slice(index, index + COLLECTOR_ACCEPTANCE.concurrency)
          .map((receipt) => collector.collect(collectorBytes(receipt), signal)),
      );
      acceptanceAssert(
        results.every(
          (result) => result.status === RECEIPT_COLLECTOR_STATUSES.STORED,
        ),
      );
    }
    const snapshot = await collectorSnapshot(path);
    acceptanceAssert(
      snapshot.entries.length === expected.length &&
        expected.every((entry) =>
          snapshot.entries.some(
            (saved) =>
              saved.key === entry.key &&
              saved.fingerprint === entry.fingerprint,
          ),
        ),
    );
  } finally {
    await store.close();
  }
  const before = await collectorSnapshot(path);
  const duplicates = await restartAcceptanceCollector(root, signal);
  acceptanceAssert(
    duplicates === expected.length &&
      (await collectorSnapshot(path)).text === before.text,
  );
  // Reopening after the child exits also proves that it released exclusive ownership.
  const reopened = await openReceiptFileStore({ path });
  await reopened.close();
  const refusals = await collectorRefusals(path, receipts, signal);
  assertAcceptanceActive(signal);
  return {
    collectorStored: expected.length,
    collectorDuplicates: duplicates,
    collectorRestarts: 1,
    collectorRefusals: refusals,
  };
}
