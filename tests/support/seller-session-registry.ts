// Several ephemeral buyers share one native VM and seller; every key, account and RPC is synthetic.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { generateKeyPairSigner } from '@solana/kit';
import { SOLANA_TESTNET_CAIP2 } from '@x402/svm';
import { uptoTokenAccount } from 'x402-upto-metered';

import { PROTOCOL_FEE } from '@gyblos/config';
import { batchSellerPathsIn, batchSessionPathsIn } from '@gyblos/config/home';
import {
  createBatchBuyer,
  openBatchSellerRegistry,
} from '@gyblos/payments-upto/batch-session';

import { nativeVm } from './paid-native-vm';
import { sessionNativeRpc } from './session-native-rpc';

interface RegistryBuyer {
  terms: import('@gyblos/protocol/payment-session').PaymentSessionTerms;
  buyer: Awaited<ReturnType<typeof createBatchBuyer>>;
  paths: ReturnType<typeof batchSessionPathsIn>;
  payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  payload: string;
}

export async function sellerRegistryRig(
  maxSessions = 2,
  nodes?: { buyerNodeIds: readonly string[]; sellerNodeId: string },
) {
  const now = () => 1_800_000_000_000;
  const vm = await nativeVm(now, SOLANA_TESTNET_CAIP2, {
    treasury: PROTOCOL_FEE.treasury,
  });
  const local = sessionNativeRpc(vm);
  const root = await mkdtemp(join(tmpdir(), 'gyb-seller-registry-'));
  const paths = batchSellerPathsIn({ GYBLOS_HOME: root });
  const options = {
    paths,
    maxSessions,
    now,
    rpcUrl: 'http://127.0.0.1:9',
    rpc: local.rpc,
    signer: vm.signer,
    feePayer: vm.feePayer,
    authorizer: vm.authorizer,
  };
  const buyers: RegistryBuyer[] = [];
  for (let index = 0; index < 3; index++) {
    const payer = index === 0 ? vm.payer : await generateKeyPairSigner();
    if (index !== 0)
      await vm.send([
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: vm.feePayer,
          mint: vm.mint.address,
          owner: payer.address,
        }),
        getMintToInstruction({
          mint: vm.mint.address,
          token: await uptoTokenAccount(
            payer.address,
            vm.mint.address,
            TOKEN_PROGRAM_ADDRESS,
          ),
          mintAuthority: vm.feePayer,
          amount: 100_000n,
        }),
      ]);
    const terms = {
      buyer: payer.address,
      buyerNodeId:
        nodes?.buyerNodeIds[index] ??
        (index + 1).toString(16).padStart(64, '0'),
      owner: vm.seller.address,
      sellerNodeId: nodes?.sellerNodeId ?? '34'.repeat(32),
      network: vm.network,
      mint: vm.mint.address,
      payTo: vm.seller.address,
      feePayer: vm.feePayer.address,
      authorizer: vm.authorizer.address,
      treasury: PROTOCOL_FEE.treasury,
      protocolFeeBps: PROTOCOL_FEE.bps,
      depositAtomic: '1000',
      withdrawDelaySeconds: 900,
      expiresAt: now() + 3_600_000,
    };
    const hints = vm.hints();
    const buyerPaths = batchSessionPathsIn(
      { GYBLOS_HOME: join(root, `buyer-${index}`) },
      'buyer',
    );
    const buyer = await createBatchBuyer({
      terms,
      payer,
      now,
      paths: buyerPaths,
      hints: async () => ({
        blockhash: hints.recentBlockhash,
        lastValidBlockHeight: hints.lastValidBlockHeight,
        slot: hints.recentSlot,
      }),
    });
    buyers.push({
      terms,
      buyer,
      paths: buyerPaths,
      payer,
      payload: await buyer.open(),
    });
  }
  return {
    vm,
    now,
    root,
    paths,
    options,
    buyers,
    open: (capacity = maxSessions) =>
      openBatchSellerRegistry({ ...options, maxSessions: capacity }),
    async dispose() {
      for (const row of buyers) await row.buyer.dispose();
    },
  };
}
