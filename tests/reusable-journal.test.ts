// Reusable-channel journal tests use synthetic signers and private temporary directories only.
import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

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

void test('reopens a private journal and reuses one channel with increasing signed vouchers', () =>
  fixture(async (root) => {
    const { payer, terms, paths, environment } = await context(root);
    let journal = await openReusableJournal({ environment });
    await track(journal, terms, payer);
    await journal.confirmOpen(terms.channelId, async () => observation(terms));
    const first = await journal.issueVoucher(
      terms.channelId,
      A,
      '40',
      payer,
      async () => observation(terms),
    );
    await journal.close();
    journal = await openReusableJournal({ environment });
    const second = await journal.issueVoucher(
      terms.channelId,
      B,
      '70',
      payer,
      async () => observation(terms),
    );
    assert.equal(first.maxClaimableAmount, '40');
    assert.equal(second.maxClaimableAmount, '70');
    assert.equal((await journal.get(terms.channelId))?.authorizedAtomic, '70');
    await assert.rejects(
      journal.issueVoucher(terms.channelId, A, '90', payer, async () =>
        observation(terms),
      ),
    );
    await assert.rejects(
      journal.issueVoucher(
        terms.channelId,
        '33'.repeat(32),
        '69',
        payer,
        async () => observation(terms),
      ),
    );
    await assert.rejects(
      journal.issueVoucher(
        terms.channelId,
        '33'.repeat(32),
        '1001',
        payer,
        async () => observation(terms),
      ),
    );
    await journal.close();
  }));

void test('a signing failure survives restart and blocks further signing', () =>
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
    journal = await openReusableJournal({ environment });
    assert.equal(
      (await journal.get(terms.channelId))?.pending?.requestDigest,
      A,
    );
    await assert.rejects(
      journal.issueVoucher(terms.channelId, B, '70', payer, async () =>
        observation(terms),
      ),
    );
    await assert.rejects(
      journal.recoverPending(
        terms.channelId,
        async () => observation(terms),
        payer,
      ),
    );
    assert.equal(
      (await journal.get(terms.channelId))?.pending?.maxClaimableAmount,
      '40',
    );
    await journal.close();
  }));

void test('refuses mismatched open observations and concurrent journal owners', () =>
  fixture(async (root) => {
    const { payer, terms, paths, environment } = await context(root);
    const journal = await openReusableJournal({ environment });
    await assert.rejects(openReusableJournal({ environment }));
    await track(journal, terms, payer);
    await assert.rejects(
      journal.confirmOpen(terms.channelId, async () => ({
        ...observation(terms),
        authorizedSigner: terms.feePayer,
      })),
    );
    await assert.rejects(
      journal.confirmOpen(terms.channelId, async () => ({
        ...observation(terms),
        distributionHash: '00'.repeat(32),
      })),
    );
    await assert.rejects(
      journal.confirmOpen(terms.channelId, async () => ({
        ...observation(terms),
        state: 'closing',
      })),
    );
    await assert.rejects(
      journal.confirmOpen(terms.channelId, async () => ({
        ...observation(terms),
        finalized: false,
      })),
    );
    assert.equal((await journal.get(terms.channelId))?.status, 'opening');
    await journal.close();
  }));

void test('a replaced lock prevents a write after an awaited observer', () =>
  fixture(async (root) => {
    const { payer, terms, paths, environment } = await context(root);
    const journal = await openReusableJournal({ environment });
    await track(journal, terms, payer);
    await assert.rejects(
      journal.confirmOpen(terms.channelId, async () => {
        await unlink(paths.lock);
        await writeFile(paths.lock, '{}', { mode: 0o600 });
        return observation(terms);
      }),
    );
    await assert.rejects(journal.close());
  }));

void test('same request cannot be signed on another seller channel', () =>
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
    await journal.issueVoucher(
      first.terms.channelId,
      A,
      '1',
      first.payer,
      async () => observation(first.terms),
    );
    await assert.rejects(
      journal.issueVoucher(
        other.terms.channelId,
        A,
        '1',
        other.payer,
        async () => observation(other.terms),
      ),
    );
    await journal.close();
  }));

void test('an uncertain opening blocks another channel for the same seller', () =>
  fixture(async (root) => {
    const { payer, terms, environment } = await context(root);
    const journal = await openReusableJournal({ environment });
    await track(journal, terms, payer);
    const other = await generateKeyPairSigner();
    await assert.rejects(
      track(journal, { ...terms, channelId: other.address }, payer),
    );
    await journal.close();
  }));

void test('tampering with a signed request digest fails closed after restart', () =>
  fixture(async (root) => {
    const { payer, terms, paths, environment } = await context(root);
    let journal = await openReusableJournal({ environment });
    await track(journal, terms, payer);
    await journal.confirmOpen(terms.channelId, async () => observation(terms));
    await journal.issueVoucher(terms.channelId, A, '40', payer, async () =>
      observation(terms),
    );
    await journal.close();
    const serialized = await readFile(paths.state, 'utf8');
    await writeFile(paths.state, serialized.replace(A, B), { mode: 0o600 });
    journal = await openReusableJournal({ environment });
    await assert.rejects(journal.get(terms.channelId));
    await journal.close();
  }));

void test('a different opening transaction cannot replace the recorded intent', () =>
  fixture(async (root) => {
    const { payer, terms, environment } = await context(root);
    const otherMint = await generateKeyPairSigner();
    const journal = await openReusableJournal({ environment });
    await journal.beginOpening(
      { ...terms, channelId: terms.buyer, salt: '0' },
      payer,
    );
    const otherMessage = await syntheticOpeningMessage(
      { ...terms, mint: otherMint.address },
      payer,
    );
    await assert.rejects(
      journal.completeOpening(terms.buyer, otherMessage, payer),
    );
    assert.equal((await journal.get(terms.buyer))?.status, 'preparing');
    await journal.close();
  }));
