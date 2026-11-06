// Verifies failure recovery, fresh observations and limits using synthetic channel identities.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import { SOLANA_MAINNET_CAIP2 } from '@x402/svm';

import { CHANNEL_PROGRAM } from '@gyblos/config';
import { openReusableJournal } from '@gyblos/payments-upto/reusable-journal';

import {
  A,
  B,
  context,
  fixture,
  observation,
  syntheticOpeningMessage,
  track,
} from './support/reusable-journal-fixture';

void test('altered opening messages are rejected before metadata signing', () =>
  fixture(async (root) => {
    const { environment, payer, terms } = await context(root);
    const journal = await openReusableJournal({ environment });
    try {
      const provisional = { ...terms, channelId: terms.buyer, salt: '0' };
      await journal.beginOpening(provisional, payer);
      const original = await syntheticOpeningMessage(terms, payer);
      const decoded = getCompiledTransactionMessageDecoder().decode(original);
      const keyed = decoded.instructions.map((instruction) => ({
        instruction,
        program: String(
          decoded.staticAccounts[instruction.programAddressIndex],
        ),
      }));
      const open = keyed.find((item) => item.program === CHANNEL_PROGRAM)
        ?.instruction.data;
      const memo = keyed.find((item) => item.program.startsWith('MemoSq'))
        ?.instruction.data;
      const price = keyed.find(
        (item) =>
          item.program.startsWith('ComputeBudget') &&
          item.instruction.data?.[0] === 3,
      )?.instruction.data;
      assert.ok(open && memo && price);
      let signs = 0;
      const observer = {
        address: payer.address,
        signMessages(...args: Parameters<typeof payer.signMessages>) {
          signs++;
          return payer.signMessages(...args);
        },
        signTransactions: payer.signTransactions.bind(payer),
      };
      for (const [part, byte] of [
        [memo, 0],
        [open, 1],
        [open, 9],
        [price, 1],
      ] as const) {
        const offset = Buffer.from(original).indexOf(Buffer.from(part));
        assert.notEqual(offset, -1);
        const mutated = Uint8Array.from(original);
        const originalByte = mutated[offset + byte];
        assert.ok(originalByte !== undefined);
        mutated[offset + byte] = originalByte ^ 1;
        await assert.rejects(
          journal.completeOpening(terms.buyer, mutated, observer),
        );
      }
      assert.equal(signs, 0);
      assert.equal((await journal.list())[0]?.status, 'preparing');
    } finally {
      await journal.close();
    }
  }));

void test('an uncertain voucher blocks every other channel until recovered', () =>
  fixture(async (root) => {
    const first = await context(root);
    const other = await context(root);
    const journal = await openReusableJournal({
      environment: first.environment,
    });
    await track(journal, first.terms, first.payer);
    await journal.confirmOpen(first.terms.channelId, async () =>
      observation(first.terms),
    );
    await track(journal, other.terms, other.payer);
    await journal.confirmOpen(other.terms.channelId, async () =>
      observation(other.terms),
    );
    let signs = 0;
    const broken = new Proxy(
      { ...first.payer },
      {
        get(target, key, receiver) {
          if (key === 'signMessages')
            return (...args: Parameters<typeof first.payer.signMessages>) => {
              signs++;
              if (signs === 2) throw new Error('synthetic');
              return target.signMessages(...args);
            };
          return Reflect.get(target, key, receiver);
        },
      },
    );
    await assert.rejects(
      journal.issueVoucher(first.terms.channelId, A, '1', broken, async () =>
        observation(first.terms),
      ),
    );
    await assert.rejects(
      journal.issueVoucher(
        other.terms.channelId,
        B,
        '1',
        other.payer,
        async () => observation(other.terms),
      ),
    );
    await journal.close();
  }));

void test('changing a signed pending amount blocks recovery after restart', () =>
  fixture(async (root) => {
    const { payer, terms, paths, environment } = await context(root);
    let journal = await openReusableJournal({ environment });
    await track(journal, terms, payer);
    await journal.confirmOpen(terms.channelId, async () => observation(terms));
    let signs = 0;
    const broken = new Proxy(
      { ...payer },
      {
        get(target, key, receiver) {
          if (key === 'signMessages')
            return (...args: Parameters<typeof payer.signMessages>) => {
              signs++;
              if (signs === 2) throw new Error('synthetic');
              return target.signMessages(...args);
            };
          return Reflect.get(target, key, receiver);
        },
      },
    );
    await assert.rejects(
      journal.issueVoucher(terms.channelId, A, '40', broken, async () =>
        observation(terms),
      ),
    );
    await journal.close();
    const source = await readFile(paths.state, 'utf8');
    const modified = source
      .replace('"authorizedAtomic":"40"', '"authorizedAtomic":"90"')
      .replace('"maxClaimableAmount":"40"', '"maxClaimableAmount":"90"');
    assert.notEqual(source, modified);
    await writeFile(paths.state, modified, { mode: 0o600 });
    journal = await openReusableJournal({ environment });
    signs = 0;
    const counting = new Proxy(
      { ...payer },
      {
        get(target, key, receiver) {
          if (key === 'signMessages')
            return (...args: Parameters<typeof payer.signMessages>) => {
              signs++;
              return target.signMessages(...args);
            };
          return Reflect.get(target, key, receiver);
        },
      },
    );
    await assert.rejects(
      journal.recoverPending(
        terms.channelId,
        async () => observation(terms),
        counting,
      ),
    );
    assert.equal(signs, 0);
    await journal.close();
  }));

void test('stale and regressing finalized observations cannot authorize a voucher', () =>
  fixture(async (root) => {
    const { payer, terms, environment } = await context(root);
    const journal = await openReusableJournal({ environment });
    await track(journal, terms, payer);
    await journal.confirmOpen(terms.channelId, async () => observation(terms));
    await assert.rejects(
      journal.issueVoucher(terms.channelId, A, '40', payer, async () => ({
        ...observation(terms),
        contextSlot: '99',
        finalizedTipSlot: '100',
      })),
    );
    await assert.rejects(
      journal.issueVoucher(terms.channelId, A, '40', payer, async () => ({
        ...observation(terms),
        contextSlot: '99',
        finalizedTipSlot: '99',
      })),
    );
    assert.equal((await journal.get(terms.channelId))?.authorizedAtomic, '0');
    await journal.close();
  }));

void test('insufficient journal capacity is refused before any new signature', () =>
  fixture(async (root) => {
    const { payer, terms, paths, environment } = await context(root);
    let journal = await openReusableJournal({ environment });
    await track(journal, terms, payer);
    await journal.confirmOpen(terms.channelId, async () => observation(terms));
    await journal.close();
    const size = Buffer.byteLength(await readFile(paths.state, 'utf8'));
    journal = await openReusableJournal({ environment, maxBytes: size + 250 });
    let signs = 0;
    const counter = new Proxy(
      { ...payer },
      {
        get(target, key, receiver) {
          if (key === 'signMessages')
            return (...args: Parameters<typeof payer.signMessages>) => {
              signs++;
              return target.signMessages(...args);
            };
          return Reflect.get(target, key, receiver);
        },
      },
    );
    await assert.rejects(
      journal.issueVoucher(terms.channelId, A, '40', counter, async () =>
        observation(terms),
      ),
    );
    assert.equal(signs, 0);
    assert.equal((await journal.get(terms.channelId))?.authorizedAtomic, '0');
    await journal.close();
  }));

void test('mainnet channel is not signed while payments are disabled', () =>
  fixture(async (root) => {
    const { payer, terms, environment } = await context(root);
    const mainnet = { ...terms, network: SOLANA_MAINNET_CAIP2 };
    const journal = await openReusableJournal({ environment });
    await track(journal, mainnet, payer);
    await journal.confirmOpen(mainnet.channelId, async () =>
      observation(mainnet),
    );
    let signs = 0;
    const counting = new Proxy(
      { ...payer },
      {
        get(target, key, receiver) {
          if (key === 'signMessages')
            return (...args: Parameters<typeof payer.signMessages>) => {
              signs++;
              return target.signMessages(...args);
            };
          return Reflect.get(target, key, receiver);
        },
      },
    );
    await assert.rejects(
      journal.issueVoucher(mainnet.channelId, A, '40', counting, async () =>
        observation(mainnet),
      ),
    );
    assert.equal(signs, 0);
    assert.equal((await journal.get(mainnet.channelId))?.authorizedAtomic, '0');
    await journal.close();
  }));

void test('unknown paid watermark blocks the next authorization', () =>
  fixture(async (root) => {
    const { payer, terms, environment } = await context(root);
    const journal = await openReusableJournal({ environment });
    await track(journal, terms, payer);
    await journal.confirmOpen(terms.channelId, async () => observation(terms));
    await journal.issueVoucher(terms.channelId, A, '40', payer, async () =>
      observation(terms),
    );
    await journal.issueVoucher(terms.channelId, B, '70', payer, async () =>
      observation(terms),
    );
    await assert.rejects(
      journal.issueVoucher(
        terms.channelId,
        '33'.repeat(32),
        '90',
        payer,
        async () => ({
          ...observation(terms),
          settledAtomic: '70',
          paidAtomic: '55',
        }),
      ),
    );
    assert.equal((await journal.get(terms.channelId))?.authorizedAtomic, '70');
    await journal.close();
  }));

void test('an opening remains blocked when its absence is only asserted by the caller', () =>
  fixture(async (root) => {
    const { payer, terms, environment } = await context(root);
    const journal = await openReusableJournal({ environment });
    await track(journal, terms, payer);
    const evidence = {
      network: terms.network,
      channelId: terms.channelId,
      finalized: true,
      programWindowVerified: true,
      contextSlot: '100',
      finalizedTipSlot: '100',
      finalizedBlockHeight: '100',
      accountAbsent: true,
      historyComplete: true,
      historyFromSlot: terms.openSlot,
      noOpenTransaction: true,
      blockhash: terms.recentBlockhash,
      blockhashValid: false,
      blockhashStatusFinalized: true,
      blockhashContextSlot: '100',
      accountContextSlot: '100',
      historyThroughSlot: '100',
      blockHeightContextSlot: '100',
    };
    await assert.rejects(
      journal.recoverNeverOpened(terms.channelId, async () => evidence, payer),
    );
    await assert.rejects(
      journal.recoverNeverOpened(
        terms.channelId,
        async () => ({
          ...evidence,
          finalizedBlockHeight: '101',
          historyComplete: false,
        }),
        payer,
      ),
    );
    await assert.rejects(
      journal.recoverNeverOpened(
        terms.channelId,
        async () => ({
          ...evidence,
          finalizedBlockHeight: '101',
          blockhashValid: true,
        }),
        payer,
      ),
    );
    await assert.rejects(
      journal.recoverNeverOpened(
        terms.channelId,
        async () => ({
          ...evidence,
          finalizedBlockHeight: '101',
          blockhashContextSlot: '99',
        }),
        payer,
      ),
    );
    await assert.rejects(
      journal.recoverNeverOpened(
        terms.channelId,
        async () => ({ ...evidence, finalizedBlockHeight: '101' }),
        payer,
      ),
    );
    assert.equal((await journal.get(terms.channelId))?.status, 'opening');
    await journal.close();
  }));
