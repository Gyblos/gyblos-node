import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import {
  assertDevnet,
  confirm,
  rpc,
} from '../packages/payments-x402/src/chain.js';
import { DEVNET_USDC } from '../packages/payments-x402/src/constants.js';
import { signer, type Config } from './config.js';

export async function prepareExactAccounts(c: Config) {
  await assertDevnet(c.rpcUrl);
  const sponsor = await signer(c, 'facilitator');
  const instructions = await Promise.all(
    [c.addresses.seller, c.addresses.authorizer].map((owner) =>
      getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: sponsor,
        owner: address(owner),
        mint: address(DEVNET_USDC),
      }),
    ),
  );
  const latest = (
    await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
      c.rpcUrl,
      'getLatestBlockhash',
      [{ commitment: 'confirmed' }],
    )
  ).value;
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(sponsor, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.blockhash),
          lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  const signature = await rpc<string>(c.rpcUrl, 'sendTransaction', [
    getBase64EncodedWireTransaction(tx),
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  await confirm(c.rpcUrl, signature);
  return signature;
}
