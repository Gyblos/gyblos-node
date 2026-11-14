// Checks durable signing intentions in the real batch store using disposable synthetic signers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { batchSessionPathsIn } from '@gyblos/config/home';
import { createBatchBuyer } from '@gyblos/payments-upto/batch-session';

import { sessionRig } from './support/batch-session';

void test('batch opening persists each exact signing intention before the signer is called', async (t) => {
  const payer = await generateKeyPairSigner();
  const rig = await sessionRig({
    buyerNodeId: '12'.repeat(32),
    sellerNodeId: '34'.repeat(32),
    payer,
  });
  await rig.buyer.dispose();
  const paths = batchSessionPathsIn({ GYBLOS_HOME: rig.root }, 'buyer');
  let transactionSigns = 0;
  let messageSigns = 0;
  const durable: boolean[] = [];
  async function saved(message: Uint8Array) {
    const record = JSON.parse(await readFile(paths.state, 'utf8'));
    const checkpoints: unknown[] = Object.values(record.pending).map((value) =>
      JSON.parse(String(value)),
    );
    durable.push(
      checkpoints.some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          'message' in entry &&
          entry.message === Buffer.from(message).toString('base64'),
      ),
    );
  }
  const options = {
    terms: rig.terms,
    paths,
    now: () => 1_800_000_000_000,
    hints: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: '1000',
      slot: '1',
    }),
    payer: {
      address: payer.address,
      signTransactions: async (
        ...args: Parameters<typeof payer.signTransactions>
      ) => {
        await saved(Uint8Array.from(args[0][0]!.messageBytes));
        transactionSigns++;
        return payer.signTransactions(...args);
      },
      signMessages: async (...args: Parameters<typeof payer.signMessages>) => {
        await saved(Uint8Array.from(args[0][0]!.content));
        messageSigns++;
        return payer.signMessages(...args);
      },
    },
  };
  let buyer = await createBatchBuyer(options);
  t.after(async () => {
    await buyer.dispose();
    await rig.seller().dispose();
  });
  const first = await buyer.open();
  assert.deepEqual(
    durable,
    [true, true],
    'exact signing bytes must already be durable',
  );
  await buyer.dispose();
  buyer = await createBatchBuyer(options);
  assert.equal(await buyer.open(), first);
  assert.equal(transactionSigns, 1);
  assert.equal(messageSigns, 1);
});
