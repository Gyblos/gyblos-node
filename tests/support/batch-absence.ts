// Owns an original never-submitted SDK deposit; recovery gets no usable signer or external transport.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';

import { batchPoolPathsIn } from '@gyblos/config/home';
import {
  createBatchBuyer,
  openBatchBuyerPool,
  recoverBatchPool,
} from '@gyblos/payments-upto/batch-session';

import { batchNativeFinancial } from './batch-native';
import { sessionNativeRpc } from './session-native-rpc';

export const ABSENCE_PREPARATIONS = {
  FULL: 'full',
  UNSIGNED: 'unsigned',
  VOUCHER: 'voucher',
} as const;
export async function batchAbsenceRig(
  t: TestContext,
  preparation: (typeof ABSENCE_PREPARATIONS)[keyof typeof ABSENCE_PREPARATIONS] = ABSENCE_PREPARATIONS.FULL,
) {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('External RPC forbidden'),
  );
  const financial = await batchNativeFinancial(() => now, {
    buyerNodeId: '12'.repeat(32),
    sellerNodeId: '34'.repeat(32),
  });
  const paths = batchPoolPathsIn({ GYBLOS_HOME: financial.root });
  if (preparation === ABSENCE_PREPARATIONS.FULL) await financial.buyer.open();
  else {
    await financial.buyer.dispose();
    const payer = financial.vm.payer;
    const interrupted = await createBatchBuyer({
      terms: financial.terms,
      paths: paths.legacy,
      now: () => now,
      hints: async () => ({
        blockhash: financial.vm.hints().recentBlockhash,
        lastValidBlockHeight: financial.vm.hints().lastValidBlockHeight,
        slot: financial.vm.hints().recentSlot,
      }),
      payer: {
        ...payer,
        signTransactions: async (...args) => {
          if (preparation === ABSENCE_PREPARATIONS.UNSIGNED)
            throw new Error('Synthetic stopped signer');
          return payer.signTransactions(...args);
        },
        signMessages: async () => {
          throw new Error('Synthetic stopped voucher');
        },
      },
    });
    await assert.rejects(interrupted.open());
    await interrupted.dispose();
  }
  if (preparation === ABSENCE_PREPARATIONS.FULL)
    await financial.buyer.dispose();
  await financial.seller().dispose();
  const local = sessionNativeRpc(financial.vm);
  let signs = 0;
  const options = {
    paths,
    payer: {
      address: financial.vm.payer.address,
      signTransactions: async () => {
        signs++;
        assert.fail('Recovery signing forbidden');
      },
      signMessages: async () => {
        signs++;
        assert.fail('Recovery signing forbidden');
      },
    },
    rpcUrl: 'http://127.0.0.1:9',
    rpc: local.rpc,
    now: () => now,
  };
  return {
    financial,
    local,
    options,
    signs: () => signs,
    recover: () => recoverBatchPool(options),
    read: async () => JSON.parse(await readFile(paths.legacy.state, 'utf8')),
    write: async (value: unknown) =>
      writeFile(paths.legacy.state, JSON.stringify(value)),
    patch(methods: Record<string, unknown>) {
      options.rpc = new Proxy(options.rpc, {
        get: (target, name) =>
          typeof name === 'string' && Object.hasOwn(methods, name)
            ? methods[name]
            : Reflect.get(target, name),
      });
    },
    async budget() {
      const pool = await openBatchBuyerPool({
        paths,
        totalDepositAtomic: '1000',
        now: () => now,
        backend: async () => assert.fail('No replacement backend'),
      });
      try {
        return await pool.budget();
      } finally {
        await pool.dispose();
      }
    },
  };
}
