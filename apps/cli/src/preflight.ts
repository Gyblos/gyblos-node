import { FIXED_MIN_FACILITATOR_LAMPORTS, MAX_ATOMIC } from '@gyblos/config';
import { loadConfig } from '@gyblos/lab-harness/config';
import {
  account,
  assertProgram,
  lamports,
  tokens,
} from '@gyblos/payments-x402/chain';
import { isMain } from '@gyblos/runtime';

export async function main() {
  try {
    const config = await loadConfig();
    await assertProgram(config.rpcUrl);
    const mint = await account(config.rpcUrl, config.mint);
    const facilitatorSol = await lamports(
      config.rpcUrl,
      config.addresses.facilitator,
    );
    const buyerTokens = mint
      ? await tokens(config.rpcUrl, config.addresses.buyer, config.mint)
      : 0n;
    const ready =
      facilitatorSol >= FIXED_MIN_FACILITATOR_LAMPORTS &&
      buyerTokens >= BigInt(MAX_ATOMIC);
    console.log(
      JSON.stringify(
        {
          devnet: true,
          programExecutable: true,
          asset: config.assetLabel,
          mint: config.mint,
          mintExists: !!mint,
          facilitator: config.addresses.facilitator,
          facilitatorLamports: facilitatorSol.toString(),
          buyer: config.addresses.buyer,
          buyerAtomic: buyerTokens.toString(),
          ready,
        },
        null,
        2,
      ),
    );
    if (!ready) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Preflight failed.');
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
