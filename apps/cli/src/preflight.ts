import { loadConfig } from '../../../scripts/config.js';
import {
  assertProgram,
  lamports,
  tokens,
  account,
} from '../../../packages/payments-x402/src/chain.js';

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
  const ready = facilitatorSol >= 10_000_000n && buyerTokens >= 10_000n;
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
