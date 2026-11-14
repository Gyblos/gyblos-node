// Owns a funded native batch fixture after both peers stop; recovery can use only its buyer key and local RPC.
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config/home';
import { recoverBatchBuyer } from '@gyblos/payments-upto/batch-session';

import { batchNativeFinancial } from './batch-native';
import { sessionNativeRpc } from './session-native-rpc';

export async function batchRecoveryRig(t: TestContext) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const financial = await batchNativeFinancial(() => now, {
    buyerNodeId: '12'.repeat(32),
    sellerNodeId: '34'.repeat(32),
  });
  await financial.seller().open(await financial.buyer.open());
  await financial.dispose();
  const local = sessionNativeRpc(financial.vm);
  const options = {
    paths: batchSessionPathsIn({ GYBLOS_HOME: financial.root }, 'buyer'),
    payer: financial.vm.payer,
    rpcUrl: 'http://127.0.0.1:9',
    rpc: local.rpc,
    now: () => now,
    sleep: async () => {},
  };
  return {
    financial,
    local,
    options,
    recover: () => recoverBatchBuyer(options),
    read: async () => JSON.parse(await readFile(options.paths.state, 'utf8')),
    grace: () => {
      now += (financial.terms.withdrawDelaySeconds + 10) * 1000;
      financial.vm.time(now / 1000);
    },
  };
}
