// Recovery admission uses synthetic journals, RPCs and signers; no live chain or key is read.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2 } from '@x402/svm';

import { DEVNET, DEVNET_GENESIS, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
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

void test('wrong-chain RPC is refused before recovery reads', async () => {
  await withJournal(async (journal) => {
    await journal.put(entry(DEVNET));
    const double = chain();
    let genesisReads = 0;
    const rpc = {
      ...double.rpc,
      getGenesisHash: () => ({
        send: async () => {
          genesisReads++;
          return 'wrong-chain';
        },
      }),
    };
    let reports = 0;
    await assert.rejects(
      reconcileUptoBuyer({
        journal,
        network: DEVNET,
        rpc,
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
    assert.equal(genesisReads, 1);
    assert.deepEqual(double.reads, []);
    assert.equal(reports, 0);
    assert.equal((await journal.list())[0]?.state, 'open');
  });
});

void test('wrong-chain RPC is refused before direct withdrawal', async () => {
  const payer = await generateKeyPairSigner();
  const double = withdrawChain({ accounts: new Map(), blockTime: 0n });
  let genesisReads = 0;
  const rpc = {
    ...double.rpc,
    getGenesisHash: () => ({
      send: async () => {
        genesisReads++;
        return 'wrong-chain';
      },
    }),
  };
  const withdrawal = createUptoWithdrawal(rpc, {
    payer,
    network: DEVNET,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  await assert.rejects(
    withdrawal.withdraw({
      channelId: ADDRESS,
      mint: ADDRESS,
      rentPayer: ADDRESS,
      maxAtomic: '1000',
      splits: [],
    }),
    refused,
  );
  assert.equal(genesisReads, 1);
  assert.deepEqual(double.reads, []);
  assert.deepEqual(double.sent, []);
});

void test('withdrawal fixes RPC methods before the genesis check', async () => {
  const payer = await generateKeyPairSigner();
  const double = withdrawChain({ accounts: new Map(), blockTime: 0n });
  let foreignReads = 0;
  const rpc = { ...double.rpc };
  rpc.getGenesisHash = () => ({
    send: async () => {
      rpc.getAccountInfo = () => ({
        send: async () => {
          foreignReads++;
          throw new Error('wrong RPC');
        },
      });
      return DEVNET_GENESIS;
    },
  });
  const withdrawal = createUptoWithdrawal(rpc, {
    payer,
    network: DEVNET,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const result = await withdrawal.withdraw({
    channelId: ADDRESS,
    mint: ADDRESS,
    rentPayer: ADDRESS,
    maxAtomic: '1000',
    splits: [],
  });
  assert.equal(result.step, 'nothing');
  assert.equal(foreignReads, 0);
  assert.equal(double.sent.length, 0);
});

void test('withdrawal reports wrong-chain and unavailable RPC errors without hiding their cause', async () => {
  for (const [paymentCode, expected] of [
    [PAYMENT_ERROR_CODES.UNAVAILABLE, 'UPTO_UNAVAILABLE'],
    [PAYMENT_ERROR_CODES.UNTRUSTED_TERMS, 'UPTO_INVALID_TERMS'],
  ] as const) {
    await withJournal(async (journal) => {
      await journal.put(entry(DEVNET));
      const results = await withdrawUptoBuyer({
        journal,
        network: DEVNET,
        withdrawal: {
          withdraw: async () => {
            throw new PaymentError(paymentCode);
          },
        },
        mint: ADDRESS,
        treasury: ADDRESS,
        protocolFeeBps: 300,
        maxTimeoutSeconds: 120,
        now: () => NOW + 500_000,
        report: async () => {},
      });
      assert.equal(results[0]?.step, 'failed');
      assert.equal(results[0]?.failure, expected);
    });
  }
});

void test('withdrawal fixes its channel and split inputs before waiting for genesis', async () => {
  const payer = await generateKeyPairSigner();
  const double = withdrawChain({ accounts: new Map(), blockTime: 0n });
  let releaseGenesis: ((value: string) => void) | undefined;
  let splitReads = 0;
  const seen: string[] = [];
  const rpc = {
    ...double.rpc,
    getGenesisHash: () => ({
      send: () =>
        new Promise<string>((resolve) => {
          releaseGenesis = resolve;
        }),
    }),
    getAccountInfo: (...args: Parameters<typeof double.rpc.getAccountInfo>) => {
      seen.push(String(args[0]));
      return double.rpc.getAccountInfo(...args);
    },
  };
  const split = { recipient: ADDRESS, bps: 1 };
  Object.defineProperty(split, 'bps', {
    get: () => {
      splitReads++;
      return 1;
    },
  });
  const query = {
    channelId: ADDRESS,
    mint: ADDRESS,
    rentPayer: ADDRESS,
    maxAtomic: '1000',
    splits: [split],
  };
  const withdrawal = createUptoWithdrawal(rpc, {
    payer,
    network: DEVNET,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const pending = withdrawal.withdraw(query);
  const readsBeforeGenesis = splitReads;
  query.channelId = 'SysvarRent111111111111111111111111111111111';
  split.recipient = query.channelId;
  assert.ok(releaseGenesis);
  releaseGenesis(DEVNET_GENESIS);
  const result = await pending;
  assert.equal(result.step, 'nothing');
  assert.deepEqual(seen, [ADDRESS]);
  assert.notEqual(readsBeforeGenesis, 0);
  assert.deepEqual(double.sent, []);
});

void test('withdrawal accepts query and split getters on a prototype', async () => {
  const payer = await generateKeyPairSigner();
  const double = withdrawChain({ accounts: new Map(), blockTime: 0n });
  let splitReads = 0;
  class Split {
    get recipient() {
      splitReads++;
      return ADDRESS;
    }
    get bps() {
      splitReads++;
      return 1;
    }
  }
  class Query {
    get channelId() {
      return ADDRESS;
    }
    get mint() {
      return ADDRESS;
    }
    get rentPayer() {
      return ADDRESS;
    }
    get maxAtomic() {
      return '1000';
    }
    get splits() {
      return [new Split()];
    }
  }
  const withdrawal = createUptoWithdrawal(double.rpc, {
    payer,
    network: DEVNET,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  assert.equal((await withdrawal.withdraw(new Query())).step, 'nothing');
  assert.equal(double.sent.length, 0);
  assert.equal(splitReads, 2);
});
