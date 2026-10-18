import {
  address, appendTransactionMessageInstructions, createTransactionMessage, getBase64EncodedWireTransaction,
  pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners, blockhash
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_PROGRAM_ADDRESS, getInitializeMint2Instruction, getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction, findAssociatedTokenPda
} from '@solana-program/token';
import { loadConfig, signer, saveJson, configPath } from './config.js';
import { account, assertProgram, confirm, lamports, rpc } from '../packages/payments-x402/src/chain.js';

try {
  const config = await loadConfig();
  await assertProgram(config.rpcUrl);
  const feePayer = await signer(config, 'facilitator');
  if (await lamports(config.rpcUrl, feePayer.address) < 50_000_000n) {
    const signature = await rpc<string>(config.rpcUrl, 'requestAirdrop', [feePayer.address, 1_000_000_000]);
    await confirm(config.rpcUrl, signature);
    console.log(JSON.stringify({ operation: 'devnet-airdrop', signature }));
  }
  if (!process.argv.includes('--test-mint')) {
    console.log('Fee payer funded. Fund buyer with devnet USDC, or use gate:fund --test-mint for the plan-approved SPL fallback.');
  } else {
    const mint = await signer(config, 'mint');
    const mintExists = !!await account(config.rpcUrl, mint.address);
    {
      const rent = await rpc<number>(config.rpcUrl, 'getMinimumBalanceForRentExemption', [82]);
      const [buyerAta] = await findAssociatedTokenPda({ owner: address(config.addresses.buyer), mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const instructions = [
        ...(!mintExists ? [
          getCreateAccountInstruction({ payer: feePayer, newAccount: mint, lamports: BigInt(rent), space: 82n, programAddress: TOKEN_PROGRAM_ADDRESS }),
          getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: feePayer.address, freezeAuthority: null }),
        ] : []),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: feePayer, owner: address(config.addresses.buyer), mint: mint.address }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: feePayer, owner: address(config.addresses.seller), mint: mint.address }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: feePayer, owner: feePayer.address, mint: mint.address }),
        // Treasury owner pinned by @x402/svm 2.28.0 for devnet; distribute validates this ATA even at zero charge.
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: feePayer, owner: address('4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap'), mint: mint.address }),
        ...(!mintExists ? [getMintToInstruction({ mint: mint.address, token: buyerAta, mintAuthority: feePayer, amount: 1_000_000n })] : []),
      ];
      const latest = (await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(config.rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
      const message = pipe(createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(feePayer, m),
        m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(latest.blockhash), lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) }, m),
        m => appendTransactionMessageInstructions(instructions, m));
      const tx = await signTransactionMessageWithSigners(message);
      const signature = await rpc<string>(config.rpcUrl, 'sendTransaction', [getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
      await confirm(config.rpcUrl, signature);
      console.log(JSON.stringify({ operation: mintExists ? 'devnet-test-accounts' : 'devnet-test-mint', mint: mint.address, signature }));
    }
    config.mint = mint.address; config.assetLabel = 'devnet-test-token';
    await saveJson(configPath(), config);
    console.log('Configured six-decimal SPL test token. This is not Circle USDC.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Devnet funding failed.'); process.exitCode = 1;
}
