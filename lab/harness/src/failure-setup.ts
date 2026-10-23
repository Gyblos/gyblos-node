// Generates a throwaway empty buyer and creates its token account, paid by the facilitator wallet,
// for the F1 empty-buyer case.
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import { COMMITMENT } from '@gyblos/config';
import { confirm, rpc } from '@gyblos/payments-x402/chain';

import { WALLET_ROLES } from './constants.js';
import { signer, type Config } from './wallet.js';

export async function prepareFailureAccounts(config: Config) {
  const sponsor = await signer(config, WALLET_ROLES.FACILITATOR);
  const emptyBuyer = await generateKeyPairSigner();
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
      appendTransactionMessageInstructions([], transactionMessage),
  );
  const instruction = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: sponsor,
    owner: emptyBuyer.address,
    mint: address(config.mint),
  });
  const transaction = await signTransactionMessageWithSigners(
    appendTransactionMessageInstructions([instruction], message),
  );
  const setupTransaction = await rpc<string>(config.rpcUrl, 'sendTransaction', [
    getBase64EncodedWireTransaction(transaction),
    { encoding: 'base64', preflightCommitment: COMMITMENT },
  ]);
  await confirm(config.rpcUrl, setupTransaction);
  return { sponsor, emptyBuyer, setupTransaction };
}
