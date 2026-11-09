// Standalone SDK opening checkpoint with a durable journal and actual LiteSVM program execution.
// Synthetic keys/token accounts only; no chain RPC, inference, vouchers, claims or real payments.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { address } from '@solana/kit';
import {
  createUptoAuthorization,
  createUptoChannelReaders,
  createUptoFacilitator,
  createUptoSdkChain,
  createUptoSeller,
  createUptoVerifier,
  memoryUptoChainStore,
  memoryUptoStore,
  UPTO_CHANNEL_STATES,
  UPTO_ERROR_CODES,
} from 'x402-upto-metered';

import {
  buyerJournalPathsIn,
  PROTOCOL_FEE,
  UPTO_CHANNEL_SETTINGS,
} from '@gyblos/config';
import {
  hasUnresolvedBuyerPayments,
  openUptoBuyerJournal,
  uptoTermsFor,
} from '@gyblos/payments-upto';
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import type { PaymentTerms } from '@gyblos/protocol/payment';

import { OPENING_DIGEST, OPENING_NOW } from '../support/opening';
import { nativeVm } from '../support/paid-native-vm';

void test('SDK native opening survives a lost confirmation and restarts with one deposit and no charge', async (context) => {
  context.mock.method(Date, 'now', () => OPENING_NOW);
  const root = await mkdtemp(join(tmpdir(), 'gyb-opening-native-'));
  const vm = await nativeVm(() => OPENING_NOW);
  const paths = buyerJournalPathsIn({ GYBLOS_HOME: root });
  let journal = await openUptoBuyerJournal({ paths, now: () => OPENING_NOW });
  let signingCalls = 0;
  try {
    // This pinned SBF was compiled with mainnet-beta; only the standalone SDK uses that label.
    // No product network guard is changed and no mainnet/devnet service is contacted.
    const terms: PaymentTerms = {
      network: vm.network,
      mint: vm.mint.address,
      treasury: vm.fee.address,
      protocolFeeBps: PROTOCOL_FEE.bps,
      maxAtomic: '1000',
      buyer: vm.payer.address,
      payTo: vm.seller.address,
      feePayer: vm.feePayer.address,
      authorizer: vm.authorizer.address,
      requestDigest: OPENING_DIGEST,
      expiresAt: OPENING_NOW + 60000,
    };
    const bound = await uptoTermsFor(terms, UPTO_CHANNEL_SETTINGS);
    const authorization = await createUptoAuthorization(
      {
        address: vm.payer.address,
        async signTransactions(...args) {
          signingCalls++;
          assert.ok(
            (await journal.get(OPENING_DIGEST))?.channelId,
            'native opening must be checkpointed before the payer signs',
          );
          return vm.payer.signTransactions(...args);
        },
      },
      bound,
      vm.hints(),
      async (opening) => {
        await journal.put({
          ...opening,
          requestDigest: OPENING_DIGEST,
          payTo: terms.payTo,
          feePayer: terms.feePayer,
          maxAtomic: terms.maxAtomic,
          expiresAt: terms.expiresAt,
          policy: {
            network: terms.network,
            mint: terms.mint,
            treasury: terms.treasury,
            protocolFeeBps: terms.protocolFeeBps,
          },
          state: PAYMENT_CHANNEL_STATES.OPEN,
          chargedAtomic: null,
        });
      },
    );
    const readers = createUptoChannelReaders(
      {
        async getAccountInfo(channelId) {
          const found = await vm.accountInfo(address(channelId), vm.network);
          if (!found) return null;
          assert.ok(
            Array.isArray(found.data) && typeof found.data[0] === 'string',
          );
          const data: [string, 'base64'] = [found.data[0], 'base64'];
          return { owner: found.owner, data };
        },
        signaturesSucceeded: async (signatures) =>
          signatures.map(vm.signatureSucceeded),
      },
      { network: vm.network, rentPayer: vm.feePayer.address },
    );
    const chainStore = memoryUptoChainStore();
    const chainOptions = {
      facilitator: createUptoFacilitator(vm.signer, chainStore),
      verify: createUptoVerifier(vm.feePayer.address, async () => vm.slot()),
      authorizer: vm.authorizer,
      store: chainStore,
      channelExists: readers.channelExists,
      settledClaim: readers.settledClaim,
      now: () => OPENING_NOW,
      openWindowMs: 90000,
      recipients: {
        ensure: async () => {
          for (const owner of [
            vm.payer.address,
            vm.feePayer.address,
            vm.seller.address,
            vm.fee.address,
          ])
            await vm.requireAccount(owner);
        },
      },
    };
    const store = memoryUptoStore();
    const makeSeller = () =>
      createUptoSeller({
        chain: createUptoSdkChain(chainOptions),
        store,
        own: bound,
        now: () => OPENING_NOW,
      });
    vm.loseConfirmation(true);
    await assert.rejects(makeSeller().admit(authorization, bound), {
      code: UPTO_ERROR_CODES.UNAVAILABLE,
    });
    assert.equal(vm.sends(), 1);
    assert.equal(await vm.balance(vm.payer.address), 99000n);
    assert.equal(await vm.balance(authorization.channelId), 1000n);
    assert.equal(
      (await store.get(authorization.channelId))?.state,
      UPTO_CHANNEL_STATES.DEPOSITING,
    );
    await journal.close();
    assert.equal(await hasUnresolvedBuyerPayments(paths), true);
    journal = await openUptoBuyerJournal({ paths, now: () => OPENING_NOW });
    const entry = await journal.get(OPENING_DIGEST);
    assert.equal(entry?.channelId, authorization.channelId);
    assert.equal(entry?.openSlot, vm.hints().recentSlot);
    assert.equal(entry?.lastValidBlockHeight, vm.hints().lastValidBlockHeight);
    assert.equal(entry?.state, PAYMENT_CHANNEL_STATES.OPEN);
    assert.equal(entry?.chargedAtomic, null);
    const seller = makeSeller();
    const recovered = await seller.recover();
    assert.equal(recovered[0]?.channelId, authorization.channelId);
    assert.equal(recovered[0]?.state, UPTO_CHANNEL_STATES.ADMITTED);
    assert.deepEqual(await seller.recover(), []);
    assert.equal(vm.sends(), 1);
    assert.equal(signingCalls, 1);
    assert.equal(await vm.balance(vm.payer.address), 99000n);
    assert.equal(await vm.balance(authorization.channelId), 1000n);
    for (const owner of [vm.seller.address, vm.fee.address])
      assert.equal(await vm.balance(owner), 0n);
  } finally {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
