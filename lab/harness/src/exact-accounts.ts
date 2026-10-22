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

import { COMMITMENT } from '@gyblos/config';
import { assertDevnet, confirm, rpc } from '@gyblos/payments-x402/chain';
import { DEVNET_USDC } from '@gyblos/payments-x402/constants';

import { signer, type Config } from './config.js';
import { WALLET_ROLES } from './constants.js';

export async function prepareExactAccounts(config: Config) {
  await assertDevnet(config.rpcUrl);
  const sponsor = await signer(config, WALLET_ROLES.FACILITATOR);
  const instructions = await Promise.all(
    [config.addresses.seller, config.addresses.authorizer].map((owner) =>
      getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: sponsor,
        owner: address(owner),
        mint: address(DEVNET_USDC),
      }),
    ),
  );
  const latest = (
    await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
      config.rpcUrl,
      'getLatestBlockhash',
      [{ commitment: COMMITMENT }],
    )
  ).value;
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (transactionMessage) =>
      setTransactionMessageFeePayerSigner(sponsor, transactionMessage),
    (transactionMessage) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.blockhash),
          lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        },
        transactionMessage,
      ),
    (transactionMessage) =>
      appendTransactionMessageInstructions(instructions, transactionMessage),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = await rpc<string>(config.rpcUrl, 'sendTransaction', [
    getBase64EncodedWireTransaction(transaction),
    { encoding: 'base64', preflightCommitment: COMMITMENT },
  ]);
  await confirm(config.rpcUrl, signature);
  return signature;
}
