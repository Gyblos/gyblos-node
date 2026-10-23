// Airdrops devnet SOL to the facilitator when low; with --test-mint, creates a six-decimal SPL test
// token, the needed token accounts and buyer balance, and switches the config to it. Devnet only.
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintToInstruction,
} from '@solana-program/token';
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
  COMMITMENT,
  DEVNET_TREASURY_OWNER,
  TOKEN_PROGRAM_ADDRESS,
} from '@gyblos/config';
import { CONFIG_ASSET_LABELS, WALLET_ROLES } from '@gyblos/config/constants';
import { configPath, loadConfig, signer } from '@gyblos/config/wallet';
import {
  account,
  assertProgram,
  confirm,
  lamports,
  rpc,
} from '@gyblos/payments-x402/chain';
import { saveJson } from '@gyblos/runtime';

import {
  FUNDING_OPERATIONS,
  GATE_FUNDING_LIMITS,
  type FundingOperation,
} from './constants.js';

interface FundingLogEntry {
  operation: FundingOperation;
  signature: string;
  mint?: string;
}

export async function fundGate() {
  try {
    const config = await loadConfig();
    await assertProgram(config.rpcUrl);
    const feePayer = await signer(config, WALLET_ROLES.FACILITATOR);
    if (
      (await lamports(config.rpcUrl, feePayer.address)) <
      GATE_FUNDING_LIMITS.airdropThreshold
    ) {
      const signature = await rpc<string>(config.rpcUrl, 'requestAirdrop', [
        feePayer.address,
        GATE_FUNDING_LIMITS.airdropLamports,
      ]);
      await confirm(config.rpcUrl, signature);
      console.log(
        JSON.stringify({
          operation: FUNDING_OPERATIONS.AIRDROP,
          signature,
        } satisfies FundingLogEntry),
      );
    }
    if (!process.argv.includes('--test-mint')) {
      console.log(
        'Fee payer funded. Fund buyer with devnet USDC, or use gate:fund --test-mint for the plan-approved SPL fallback.',
      );
    } else {
      const mint = await signer(config, WALLET_ROLES.MINT);
      const mintExists = !!(await account(config.rpcUrl, mint.address));
      {
        const rent = await rpc<number>(
          config.rpcUrl,
          'getMinimumBalanceForRentExemption',
          [GATE_FUNDING_LIMITS.mintAccountBytes],
        );
        const [buyerAta] = await findAssociatedTokenPda({
          owner: address(config.addresses.buyer),
          mint: mint.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        });
        const instructions = [
          ...(!mintExists
            ? [
                getCreateAccountInstruction({
                  payer: feePayer,
                  newAccount: mint,
                  lamports: BigInt(rent),
                  space: GATE_FUNDING_LIMITS.mintAccountSpace,
                  programAddress: TOKEN_PROGRAM_ADDRESS,
                }),
                getInitializeMint2Instruction({
                  mint: mint.address,
                  decimals: GATE_FUNDING_LIMITS.tokenDecimals,
                  mintAuthority: feePayer.address,
                  freezeAuthority: null,
                }),
              ]
            : []),
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: feePayer,
            owner: address(config.addresses.buyer),
            mint: mint.address,
          }),
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: feePayer,
            owner: address(config.addresses.seller),
            mint: mint.address,
          }),
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: feePayer,
            owner: feePayer.address,
            mint: mint.address,
          }),
          // Treasury owner pinned by the configured x402 SDK for devnet; distribute validates this ATA even at zero charge.
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: feePayer,
            owner: address(DEVNET_TREASURY_OWNER),
            mint: mint.address,
          }),
          ...(!mintExists
            ? [
                getMintToInstruction({
                  mint: mint.address,
                  token: buyerAta,
                  mintAuthority: feePayer,
                  amount: GATE_FUNDING_LIMITS.testMintAmount,
                }),
              ]
            : []),
        ];
        const latest = (
          await rpc<{
            value: { blockhash: string; lastValidBlockHeight: number };
          }>(config.rpcUrl, 'getLatestBlockhash', [{ commitment: COMMITMENT }])
        ).value;
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (transactionMessage) =>
            setTransactionMessageFeePayerSigner(feePayer, transactionMessage),
          (transactionMessage) =>
            setTransactionMessageLifetimeUsingBlockhash(
              {
                blockhash: blockhash(latest.blockhash),
                lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
              },
              transactionMessage,
            ),
          (transactionMessage) =>
            appendTransactionMessageInstructions(
              instructions,
              transactionMessage,
            ),
        );
        const transaction = await signTransactionMessageWithSigners(message);
        const signature = await rpc<string>(config.rpcUrl, 'sendTransaction', [
          getBase64EncodedWireTransaction(transaction),
          { encoding: 'base64', preflightCommitment: COMMITMENT },
        ]);
        await confirm(config.rpcUrl, signature);
        console.log(
          JSON.stringify({
            operation: mintExists
              ? FUNDING_OPERATIONS.TEST_ACCOUNTS
              : FUNDING_OPERATIONS.TEST_MINT,
            mint: mint.address,
            signature,
          } satisfies FundingLogEntry),
        );
      }
      config.mint = mint.address;
      config.assetLabel = CONFIG_ASSET_LABELS.TEST_TOKEN;
      await saveJson(configPath(), config);
      console.log(
        'Configured six-decimal SPL test token. This is not Circle USDC.',
      );
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Devnet funding failed.',
    );
    process.exitCode = 1;
  }
}
