// Child-only restart probe. Reads one owned synthetic snapshot and sends only a duplicate count over IPC.
import { RECEIPT_COLLECTOR_STATUSES } from '@gyblos/core/constants';
import { createPrivateReceiptCollector } from '@gyblos/core/receipt-collector';
import { isMain } from '@gyblos/runtime';
import { openReceiptFileStore } from '@gyblos/telemetry-file/receipt-store';

import { ACCEPTANCE_CODES } from './constants';
import { acceptanceAssert, AcceptanceError } from './errors';
import {
  collectorBytes,
  collectorPath,
  collectorSnapshot,
} from './receipt-collector-state';

export async function withCollectorOffline<T>(
  run: () => Promise<T>,
): Promise<T> {
  const previous = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new AcceptanceError(ACCEPTANCE_CODES.EXTERNAL_IO);
  };
  try {
    const result = await run();
    if (attempts) throw new AcceptanceError(ACCEPTANCE_CODES.EXTERNAL_IO);
    return result;
  } finally {
    globalThis.fetch = previous;
  }
}

async function main() {
  const root = process.cwd();
  acceptanceAssert(
    process.env.GYBLOS_HOME === root &&
      process.env.GYBLOS_LAB_HOME === root &&
      process.send,
  );
  const path = await collectorPath(root);
  const snapshot = await collectorSnapshot(path);
  const store = await openReceiptFileStore({ path });
  try {
    const collector = createPrivateReceiptCollector(store);
    let duplicates = 0;
    for (const entry of snapshot.entries) {
      acceptanceAssert(
        (await collector.collect(collectorBytes(entry.receipt))).status ===
          RECEIPT_COLLECTOR_STATUSES.DUPLICATE,
      );
      duplicates++;
    }
    acceptanceAssert((await collectorSnapshot(path)).text === snapshot.text);
    process.send!({ duplicates });
  } finally {
    await store.close();
  }
}
if (isMain(import.meta.url)) {
  try {
    await withCollectorOffline(main);
  } catch {
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}
