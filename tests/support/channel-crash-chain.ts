// Authoritative parent VM and SDK seller survive buyer death; every RPC is an owned IPC port.
// TESTNET is only the offline backend label matching this SBF treasury, never a public connection.
import assert from 'node:assert/strict';

import {
  address,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  signature,
  signBytes,
} from '@solana/kit';
import { SOLANA_TESTNET_CAIP2 } from '@x402/svm';
import {
  createUptoChannelReaders,
  createUptoFacilitator,
  createUptoSdkChain,
  createUptoSeller,
  createUptoVerifier,
  memoryUptoChainStore,
  memoryUptoStore,
  UPTO_FINAL_COMMITMENT,
  type UptoAuthorization,
} from 'x402-upto-metered';

import { PROTOCOL_FEE, UPTO_CHANNEL_SETTINGS } from '@gyblos/config';
import { uptoTermsFor } from '@gyblos/payments-upto';
import type { PaymentTerms } from '@gyblos/protocol/payment';

import {
  CHANNEL_CRASH,
  CRASH_CALLS,
  CRASH_CUTS,
  type CrashCall,
  type CrashCut,
} from './channel-crash-constants';
import { crashObject } from './channel-crash-rpc';
import { nativeVm } from './paid-native-vm';

export async function crashChain() {
  let now: number = CHANNEL_CRASH.now;
  const vm = await nativeVm(() => now, SOLANA_TESTNET_CAIP2);
  const terms: PaymentTerms = {
    network: vm.network,
    mint: vm.mint.address,
    treasury: vm.fee.address,
    protocolFeeBps: PROTOCOL_FEE.bps,
    maxAtomic: CHANNEL_CRASH.deposit,
    buyer: vm.payer.address,
    payTo: vm.seller.address,
    feePayer: vm.feePayer.address,
    authorizer: vm.authorizer.address,
    requestDigest: CHANNEL_CRASH.digest,
    expiresAt: now + 60_000,
  };
  const bound = await uptoTermsFor(terms, UPTO_CHANNEL_SETTINGS);
  const readers = createUptoChannelReaders(
    {
      async getAccountInfo(key) {
        const found = await vm.accountInfo(address(key), vm.network);
        if (!found) return null;
        assert.ok(
          Array.isArray(found.data) && typeof found.data[0] === 'string',
        );
        const data: [string, 'base64'] = [found.data[0], 'base64'];
        return { owner: found.owner, data };
      },
      signaturesSucceeded: async (keys) => keys.map(vm.signatureSucceeded),
    },
    { network: vm.network, rentPayer: vm.feePayer.address },
  );
  const store = memoryUptoChainStore();
  const server = createUptoSeller({
    own: bound,
    now: () => now,
    store: memoryUptoStore(),
    chain: createUptoSdkChain({
      facilitator: createUptoFacilitator(vm.signer, store),
      store,
      authorizer: vm.authorizer,
      verify: createUptoVerifier(vm.feePayer.address, async () => vm.slot()),
      channelExists: readers.channelExists,
      settledClaim: readers.settledClaim,
      now: () => now,
      openWindowMs: 90_000,
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
    }),
  });
  let signs = 0;
  let lastSigned: string | undefined;
  let genesis = vm.network.split(':')[1]!;
  let expectedAtomic = '0';
  let hiddenTransactions = false;
  const text = (value: unknown) => {
    assert.ok(typeof value === 'string');
    return value;
  };
  const handle = async (
    method: CrashCall,
    args: readonly unknown[],
    cut: CrashCut | undefined,
    pause: () => Promise<void>,
  ): Promise<unknown> => {
    if (method === CRASH_CALLS.SIGN) {
      assert.ok(Array.isArray(args[0]));
      return Promise.all(
        args[0].map(async (raw) => {
          const transaction = getTransactionDecoder().decode(
            Buffer.from(text(raw), 'base64'),
          );
          assert.ok(Object.hasOwn(transaction.signatures, vm.payer.address));
          signs++;
          const signed = await signBytes(
            vm.payer.keyPair.privateKey,
            transaction.messageBytes,
          );
          lastSigned = getBase64EncodedWireTransaction({
            ...transaction,
            signatures: {
              ...transaction.signatures,
              [vm.payer.address]: signed,
            },
          });
          return signed;
        }),
      );
    }
    if (method === CRASH_CALLS.ADMIT) {
      const value = crashObject(args[0]);
      const authorization: UptoAuthorization = {
        channelId: text(value.channelId),
        payer: text(value.payer),
        maxAtomic: text(value.maxAtomic),
        payload: text(value.payload),
      };
      if (cut === CRASH_CUTS.OPEN_INFLIGHT) await pause();
      await server.admit(authorization, bound);
      if (cut === CRASH_CUTS.OPEN_INCLUDED) await pause();
      return null;
    }
    if (method === CRASH_CALLS.GENESIS) return genesis;
    if (method === CRASH_CALLS.SLOT) return vm.slot();
    if (method === CRASH_CALLS.TIME) return vm.blockTime();
    if (method === CRASH_CALLS.BLOCKHASH) return vm.hints();
    if (method === CRASH_CALLS.EPOCH)
      return { absoluteSlot: vm.slot(), blockHeight: vm.height() };
    if (method === CRASH_CALLS.OLDEST) return vm.history.oldestSlot;
    if (method === CRASH_CALLS.ACCOUNT) {
      const config = crashObject(args[1]);
      if (config.minContextSlot !== undefined)
        assert.ok(
          typeof config.minContextSlot === 'bigint' &&
            vm.slot() >= config.minContextSlot,
        );
      const found = await vm.accountInfo(address(text(args[0])), vm.network);
      return {
        value: found ? { owner: found.owner, data: found.data } : null,
        context: { slot: vm.slot() },
      };
    }
    if (method === CRASH_CALLS.SEND) {
      if (
        cut === CRASH_CUTS.CLOSE_INFLIGHT ||
        cut === CRASH_CUTS.REFUND_INFLIGHT
      )
        await pause();
      const wire = text(args[0]);
      await vm.signer.simulateTransaction(wire, vm.network, {
        sigVerify: true,
      });
      const sent = await vm.signer.sendTransaction(wire, vm.network);
      if (
        cut === CRASH_CUTS.CLOSE_INCLUDED ||
        cut === CRASH_CUTS.REFUND_INCLUDED
      )
        await pause();
      return sent;
    }
    if (method === CRASH_CALLS.STATUSES) {
      assert.ok(Array.isArray(args[0]));
      return {
        context: { slot: vm.slot() },
        value: args[0].map((raw) => {
          const found = vm.history.status(signature(text(raw)));
          return found
            ? { ...found, confirmationStatus: UPTO_FINAL_COMMITMENT }
            : null;
        }),
      };
    }
    if (method === CRASH_CALLS.HISTORY) {
      const config = crashObject(args[1]);
      assert.ok(typeof config.limit === 'number');
      return vm.history.signatures(
        text(args[0]),
        config.before === undefined ? undefined : text(config.before),
        config.limit,
      );
    }
    if (method === CRASH_CALLS.TRANSACTION)
      return hiddenTransactions
        ? null
        : vm.history.transaction(signature(text(args[0])));
    throw new Error('Unknown owned crash RPC');
  };
  return {
    vm,
    terms,
    handle,
    now: () => now,
    advance(milliseconds: number) {
      now += milliseconds;
      vm.time(now / 1000);
    },
    signs: () => signs,
    hideTransactions(value: boolean) {
      hiddenTransactions = value;
    },
    expected: () => expectedAtomic,
    async claim(channelId: string, amount: string) {
      expectedAtomic = amount;
      return server.settle(channelId, amount);
    },
    badGenesis() {
      genesis = '11111111111111111111111111111111';
    },
    async expire() {
      vm.expire();
      if (!lastSigned) return;
      let wire = lastSigned;
      const decoded = getTransactionDecoder().decode(
        Buffer.from(wire, 'base64'),
      );
      if (Object.hasOwn(decoded.signatures, vm.feePayer.address))
        wire = await vm.signer.signTransaction(
          wire,
          vm.feePayer.address,
          vm.network,
        );
      await assert.rejects(
        vm.signer.simulateTransaction(wire, vm.network, { sigVerify: true }),
        /BlockhashNotFound/,
      );
    },
  };
}
