// Registers lifecycle shutdown before disposable-directory removal; never operates on an existing home.
import type { TestContext } from 'node:test';

import { receiptFileFixture } from './receipt-file-fixture';

export async function managedReceiptFixture(context: TestContext) {
  const managed: { close(): Promise<void> }[] = [];
  context.after(async () => {
    for (const item of [...managed].reverse()) await item.close();
  });
  const fixture = await receiptFileFixture(context);
  return {
    ...fixture,
    manage<T extends { close(): Promise<void> }>(value: T): T {
      managed.push(value);
      return value;
    },
  };
}
