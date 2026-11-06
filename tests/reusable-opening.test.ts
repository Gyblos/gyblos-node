// Exercises offline channel-open construction with synthetic keys and a private temporary home.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { SOLANA_MAINNET_CAIP2, USDC_MAINNET_ADDRESS } from '@x402/svm';

import { DEVNET, PROTOCOL_FEE, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import { openReusableJournal } from '@gyblos/payments-upto/reusable-journal';
import {
  createReusableOpening,
  reusableOpeningMemo,
} from '@gyblos/payments-upto/reusable-opening';

void test('opening signs only a transaction, no voucher or external call, and records its terms', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-reusable-opening-'));
  const payer = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const fee = await generateKeyPairSigner();
  const treasury = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  const hash = await generateKeyPairSigner();
  const attacker = await generateKeyPairSigner();
  let transactionSigns = 0;
  let messageSigns = 0;
  const signer = new Proxy(
    { ...payer },
    {
      get(target, key, receiver) {
        if (key === 'signTransactions')
          return (...args: Parameters<typeof payer.signTransactions>) => {
            transactionSigns++;
            return target.signTransactions(...args);
          };
        if (key === 'signMessages')
          return (...args: Parameters<typeof payer.signMessages>) => {
            messageSigns++;
            return target.signMessages(...args);
          };
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error('network disabled');
  };
  const journal = await openReusableJournal({
    environment: { GYBLOS_HOME: root },
  });
  try {
    const options = {
      journal,
      signer,
      network: DEVNET,
      mint: mint.address,
      sellerNodeId: 'ab'.repeat(32),
      payTo: seller.address,
      feePayer: fee.address,
      treasury: treasury.address,
      protocolFeeBps: PROTOCOL_FEE.bps,
      depositAtomic: '10000',
      policy: {
        network: DEVNET,
        mint: mint.address,
        treasury: treasury.address,
        protocolFeeBps: PROTOCOL_FEE.bps,
        maxDepositAtomic: '10000',
      },
      openSlot: '0',
      lastValidBlockHeight: '10',
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      gracePeriod: 60,
      recentBlockhash: hash.address,
    };
    await assert.rejects(
      createReusableOpening({
        ...options,
        network: SOLANA_MAINNET_CAIP2,
        mint: USDC_MAINNET_ADDRESS,
        depositAtomic: '1000',
        policy: {
          ...options.policy,
          network: SOLANA_MAINNET_CAIP2,
          mint: USDC_MAINNET_ADDRESS,
          maxDepositAtomic: '1000',
        },
      }),
    );
    await assert.rejects(
      createReusableOpening({
        ...options,
        policy: { ...options.policy, maxDepositAtomic: '9999' },
      }),
    );
    await assert.rejects(
      createReusableOpening({
        ...options,
        policy: { ...options.policy, maxDepositAtomic: '18446744073709551616' },
      }),
    );
    await assert.rejects(
      createReusableOpening({ ...options, tokenProgram: attacker.address }),
    );
    await assert.rejects(
      createReusableOpening({ ...options, treasury: attacker.address }),
    );
    await assert.rejects(
      createReusableOpening({ ...options, mint: attacker.address }),
    );
    assert.equal(transactionSigns, 0);
    assert.equal(messageSigns, 0);
    assert.deepEqual(await journal.list(), []);
    let preparedBeforeSigning = false;
    class PrototypeSigner {
      get address() {
        return payer.address;
      }
      signMessages(...args: Parameters<typeof payer.signMessages>) {
        messageSigns++;
        return payer.signMessages(...args);
      }
      async signTransactions(
        ...args: Parameters<typeof payer.signTransactions>
      ) {
        const records = await journal.list();
        preparedBeforeSigning = records.some(
          (item) =>
            item.status === 'opening' && item.terms.channelId !== payer.address,
        );
        transactionSigns++;
        return payer.signTransactions(...args);
      }
    }
    const observeSigner = new PrototypeSigner();
    const result = await createReusableOpening({
      ...options,
      signer: observeSigner,
    });
    assert.equal(preparedBeforeSigning, true);
    assert.equal(networkCalls, 0);
    // The wrapper checks durable preparation at the transaction-signing boundary.
    assert.equal(transactionSigns, 1);
    // Metadata signatures bind the journal terms; neither is a claimable voucher.
    assert.equal(messageSigns, 2);
    assert.equal(result.payload.authorizedSigner, payer.address);
    assert.equal('voucher' in result.payload, false);
    const saved = await journal.get(result.payload.channelId);
    assert.equal(saved?.authorizedAtomic, '0');
    assert.ok(saved);
    const wire = getTransactionDecoder().decode(
      getBase64Encoder().encode(result.payload.openTransaction),
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      wire.messageBytes,
    );
    assert.equal(message.lifetimeToken, saved.terms.recentBlockhash);
    const memo = message.instructions.find(
      (ix) =>
        String(message.staticAccounts[ix.programAddressIndex]) ===
        'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    );
    assert.ok(memo?.data);
    assert.equal(
      new TextDecoder().decode(memo.data),
      await reusableOpeningMemo(saved.terms),
    );
    const { tokenProgram, ...otherTerms } = saved.terms;
    const reordered = { tokenProgram, ...otherTerms };
    assert.equal(
      await reusableOpeningMemo(reordered),
      await reusableOpeningMemo(saved.terms),
    );
    const frozenJournal = await openReusableJournal({
      environment: { GYBLOS_HOME: join(root, 'frozen-signer') },
    });
    try {
      assert.equal(Object.isFrozen(payer), true);
      const frozenResult = await createReusableOpening({
        ...options,
        journal: frozenJournal,
        signer: payer,
      });
      assert.equal(
        (await frozenJournal.get(frozenResult.payload.channelId))?.status,
        'opening',
      );
    } finally {
      await frozenJournal.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

void test('failure during opening signature preserves a blocking intent after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-open-intent-'));
  const payer = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const fee = await generateKeyPairSigner();
  const treasury = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  const hash = await generateKeyPairSigner();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network disabled');
  };
  const signer = new Proxy(
    { ...payer },
    {
      get(target, key, receiver) {
        if (key === 'signTransactions')
          return async () => {
            throw new Error('synthetic failure');
          };
        return Reflect.get(target, key, receiver);
      },
    },
  );
  let journal = await openReusableJournal({
    environment: { GYBLOS_HOME: root },
  });
  try {
    const options = {
      journal,
      signer,
      network: DEVNET,
      mint: mint.address,
      sellerNodeId: 'ab'.repeat(32),
      payTo: seller.address,
      feePayer: fee.address,
      treasury: treasury.address,
      protocolFeeBps: PROTOCOL_FEE.bps,
      depositAtomic: '10000',
      policy: {
        network: DEVNET,
        mint: mint.address,
        treasury: treasury.address,
        protocolFeeBps: PROTOCOL_FEE.bps,
        maxDepositAtomic: '10000',
      },
      openSlot: '0',
      lastValidBlockHeight: '10',
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      gracePeriod: 60,
      recentBlockhash: hash.address,
    };
    await assert.rejects(createReusableOpening(options));
    assert.equal((await journal.list())[0]?.status, 'opening');
    await journal.close();
    journal = await openReusableJournal({ environment: { GYBLOS_HOME: root } });
    assert.equal((await journal.list())[0]?.status, 'opening');
    await assert.rejects(
      createReusableOpening({ ...options, journal, signer: payer }),
    );
    const held = (await journal.list())[0];
    assert.ok(held);
    await assert.rejects(
      journal.recoverNeverOpened(
        held.terms.channelId,
        async () => ({
          network: held.terms.network,
          channelId: held.terms.channelId,
          finalized: true,
          programWindowVerified: true,
          contextSlot: '100',
          finalizedTipSlot: '100',
          finalizedBlockHeight: '11',
          accountAbsent: true,
          historyComplete: true,
          historyFromSlot: held.terms.openSlot,
          noOpenTransaction: true,
          blockhash: held.terms.recentBlockhash,
          blockhashValid: false,
          blockhashStatusFinalized: true,
          blockhashContextSlot: '100',
          accountContextSlot: '100',
          historyThroughSlot: '100',
          blockHeightContextSlot: '100',
        }),
        payer,
      ),
    );
    assert.equal((await journal.get(held.terms.channelId))?.status, 'opening');
  } finally {
    globalThis.fetch = originalFetch;
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
