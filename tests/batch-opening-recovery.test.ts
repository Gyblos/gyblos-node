// Checks durable signing intentions in the real batch store using disposable synthetic signers.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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

void test('a lost voucher signing reply reuses the exact cached deposit signature and original lifetime', async (t) => {
  const rig = await sessionRig();
  await rig.buyer.dispose();
  const payer = rig.buyerOptions.payer;
  let transactionSigns = 0;
  let voucherSigns = 0;
  let hintReads = 0;
  const messages: string[] = [];
  const options = {
    ...rig.buyerOptions,
    hints: async () => {
      hintReads++;
      return rig.buyerOptions.hints();
    },
    payer: {
      address: payer.address,
      signTransactions: async (
        ...args: Parameters<typeof payer.signTransactions>
      ) => {
        transactionSigns++;
        return payer.signTransactions(...args);
      },
      signMessages: async (...args: Parameters<typeof payer.signMessages>) => {
        messages.push(Buffer.from(args[0][0]!.content).toString('base64'));
        const signed = await payer.signMessages(...args);
        voucherSigns++;
        if (voucherSigns === 1)
          throw new Error('Synthetic signer response lost');
        return signed;
      },
    },
  };
  let buyer = await createBatchBuyer(options);
  t.after(async () => {
    await buyer.dispose();
    await rig.seller().dispose();
  });
  await assert.rejects(buyer.open());
  const before = JSON.parse(await readFile(options.paths.state, 'utf8'));
  await buyer.dispose();
  buyer = await createBatchBuyer(options);
  await buyer.open();
  const after = JSON.parse(await readFile(options.paths.state, 'utf8'));
  assert.equal(
    transactionSigns,
    1,
    'already stored deposit signature is never requested again',
  );
  assert.equal(hintReads, 1);
  assert.equal(after.salt, before.salt);
  assert.deepEqual(after.hints, before.hints);
  assert.equal(
    new Set(messages).size,
    1,
    'only the original zero voucher is signed',
  );
  assert.deepEqual(
    after.pending,
    {},
    'completed opening replaces its transient checkpoints',
  );
});

void test('failure to save an opening intention prevents any signer call and resumes the original preparation', async (t) => {
  const rig = await sessionRig();
  await rig.buyer.dispose();
  const payer = rig.buyerOptions.payer;
  let signs = 0;
  const options = {
    ...rig.buyerOptions,
    payer: {
      address: payer.address,
      signMessages: payer.signMessages.bind(payer),
      signTransactions: async (
        ...args: Parameters<typeof payer.signTransactions>
      ) => {
        signs++;
        return payer.signTransactions(...args);
      },
    },
  };
  let buyer = await createBatchBuyer(options);
  const rename = fs.rename;
  let reject = true;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === options.paths.state && reject) {
      const next = JSON.parse(await readFile(args[0], 'utf8'));
      if (Object.keys(next.pending).length)
        throw new Error('Synthetic checkpoint write refused');
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await buyer.dispose();
    await rig.seller().dispose();
  });
  await assert.rejects(buyer.open());
  assert.equal(signs, 0);
  const before = JSON.parse(await readFile(options.paths.state, 'utf8'));
  reject = false;
  await buyer.dispose();
  buyer = await createBatchBuyer(options);
  await buyer.open();
  const after = JSON.parse(await readFile(options.paths.state, 'utf8'));
  assert.equal(after.salt, before.salt);
  assert.deepEqual(after.hints, before.hints);
  assert.equal(signs, 1);
});
