// Recovery admission uses synthetic journals, RPCs and signers; no live chain or key is read.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2 } from '@x402/svm';

import { DEVNET, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import {
  createUptoWithdrawal,
  reconcileUptoBuyer,
  withdrawUptoBuyer,
  type UptoBuyerJournal,
  type UptoBuyerWithdrawOptions,
  type UptoBuyerWithdrawResult,
  type UptoReconcileOptions,
  type UptoReconcileResult,
} from '@gyblos/payments-upto';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import { ADDRESS, entry, NOW, withJournal } from './support/mainnet-journal';
import { chainDouble } from './support/upto-chain-history';
import { withdrawChain } from './support/upto-withdraw-chain';

const refused = (error: unknown) =>
  error instanceof PaymentError &&
  error.code === PAYMENT_ERROR_CODES.UNTRUSTED_TERMS;
function chain() {
  return chainDouble({
    mint: ADDRESS,
    history: new Map(),
    blockHeight: 2n,
    oldestSlot: 0n,
    accounts: new Set(),
  });
}

void test('mainnet recovery and direct withdrawal remain disabled before RPC or reports', async () => {
  await withJournal(async (journal) => {
    await journal.put(entry(SOLANA_MAINNET_CAIP2));
    const double = chain();
    let reports = 0;
    let withdrawals = 0;
    await assert.rejects(
      reconcileUptoBuyer({
        journal,
        network: SOLANA_MAINNET_CAIP2,
        rpc: double.rpc,
        payer: ADDRESS,
        mint: ADDRESS,
        treasury: ADDRESS,
        expected: () => undefined,
        report: async () => {
          reports++;
        },
      }),
      refused,
    );
    await assert.rejects(
      withdrawUptoBuyer({
        journal,
        network: SOLANA_MAINNET_CAIP2,
        withdrawal: {
          withdraw: async () => {
            withdrawals++;
            throw new Error('unexpected');
          },
        },
        mint: ADDRESS,
        treasury: ADDRESS,
        protocolFeeBps: 300,
        maxTimeoutSeconds: 120,
        now: () => NOW,
        report: async () => {
          reports++;
        },
      }),
      refused,
    );
    assert.deepEqual(double.reads, []);
    assert.equal(reports, 0);
    assert.equal(withdrawals, 0);
    assert.equal((await journal.list())[0]?.state, 'open');
  });
  const payer = await generateKeyPairSigner();
  const double = withdrawChain({ accounts: new Map(), blockTime: 0n });
  assert.throws(
    () =>
      createUptoWithdrawal(double.rpc, {
        payer,
        network: SOLANA_MAINNET_CAIP2,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    refused,
  );
  assert.equal(double.sent.length, 0);
});

void test('recovery options implemented by class methods keep their receiver', async () => {
  await withJournal(async (journal) => {
    await journal.put(entry(DEVNET));
    const double = chain();
    class Reconcile implements UptoReconcileOptions {
      network = DEVNET;
      rpc = double.rpc;
      payer = ADDRESS;
      mint = ADDRESS;
      treasury = ADDRESS;
      calls = 0;
      constructor(readonly journal: UptoBuyerJournal) {}
      expected() {
        this.calls++;
        return undefined;
      }
      async report(_result: UptoReconcileResult) {
        this.calls++;
      }
    }
    const options = new Reconcile(journal);
    await reconcileUptoBuyer(options);
    assert.equal(options.calls, 2);
  });
  await withJournal(async (journal) => {
    await journal.put(entry(DEVNET));
    class Withdraw implements UptoBuyerWithdrawOptions {
      network = DEVNET;
      mint = ADDRESS;
      treasury = ADDRESS;
      protocolFeeBps = 300;
      maxTimeoutSeconds = 120;
      calls = 0;
      withdrawal = {
        withdraw: async () => {
          throw new Error('not needed');
        },
      };
      constructor(readonly journal: UptoBuyerJournal) {}
      now() {
        this.calls++;
        return NOW;
      }
      async report(_result: UptoBuyerWithdrawResult) {
        this.calls++;
      }
    }
    const options = new Withdraw(journal);
    await withdrawUptoBuyer(options);
    assert.equal(options.calls, 2);
  });
});
