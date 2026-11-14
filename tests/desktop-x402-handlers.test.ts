// A foreign renderer cannot read spending metadata, issue requests or open arbitrary links.
import assert from 'node:assert/strict';
import test from 'node:test';

import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createX402Handlers } from '@gyblos/desktop/x402-handlers';
import { X402_ACTION } from '@gyblos/desktop/x402-model';

void test('only the owning main frame may access the x402 bridge', async () => {
  let reads = 0;
  let opened = 0;
  const budget = new X402Budget({
    read: async () => {
      reads++;
      return undefined;
    },
    write: async () => {},
  });
  const client = new X402Client(budget);
  const contents = {};
  const mainFrame = {};
  const handler = createX402Handlers(
    client,
    budget,
    {
      contents,
      mainFrame: () => mainFrame,
      destroyed: () => false,
    },
    async () => {
      opened++;
    },
  );
  await assert.rejects(() =>
    handler({ sender: {}, senderFrame: mainFrame }, [
      { action: X402_ACTION.STATUS },
    ]),
  );
  await assert.rejects(() =>
    handler({ sender: contents, senderFrame: {} }, [
      { action: X402_ACTION.STATUS },
    ]),
  );
  assert.equal(reads, 0);
  const result = await handler({ sender: contents, senderFrame: mainFrame }, [
    { action: X402_ACTION.STATUS },
  ]);
  assert.equal(result.summary.available, true);
  assert.equal(reads, 1);
  const refused = await handler({ sender: contents, senderFrame: mainFrame }, [
    {
      action: X402_ACTION.EXPLORER,
      id: 'https://example.com/',
    },
  ]);
  assert.ok(refused.error);
  assert.equal(opened, 0);
});
