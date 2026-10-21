import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { getTransferSolInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
} from '@solana/kit';

import {
  COMMITMENT,
  CONFIG_PATH,
  DEVNET_TREASURY_OWNER,
  FILE_MODES,
  keyFilename,
  P2P,
  PAYMENT_LIMITS,
} from '@gyblos/config';
import { tokenAddress } from '@gyblos/gate/chain';
import { loadConfig, signer, type Config } from '@gyblos/gate/config';
import { withExclusiveLock } from '@gyblos/gate/lock';
import {
  assertProgram,
  confirm,
  lamports,
  rpc,
  tokens,
} from '@gyblos/payments-x402/chain';
import { saveJson } from '@gyblos/runtime';

async function fundRolesUnlocked(
  operatorRoot: string,
  buyerAddress: string,
  feePayerAddress: string,
) {
  try {
    const previous = JSON.parse(await readFile(P2P.fundingJournal, 'utf8')) as {
      state: string;
    };
    assert.equal(
      previous.state,
      'confirmed',
      'Previous funding is uncertain; reconcile before creating another transaction.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = await fundingConfig(operatorRoot),
    payer = await signer(config, 'facilitator'),
    source = await signer(config, 'buyer');
  assert.notEqual(buyerAddress, source.address);
  assert.notEqual(feePayerAddress, payer.address);
  assert.ok(
    (await lamports(config.rpcUrl, payer.address)) > P2P.docker.fundLamports,
  );
  const sourceBalance = await tokens(
    config.rpcUrl,
    source.address,
    config.mint,
  );
  assert.ok(sourceBalance >= P2P.docker.fundTokens);
  const instructions: Instruction[] = [
    getTransferSolInstruction({
      source: payer,
      destination: address(feePayerAddress),
      amount: P2P.docker.fundLamports,
    }),
  ];
  for (const owner of [
    buyerAddress,
    feePayerAddress,
    config.addresses.seller,
    DEVNET_TREASURY_OWNER,
  ])
    instructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer,
        owner: address(owner),
        mint: address(config.mint),
      }),
    );
  instructions.push(
    getTransferCheckedInstruction({
      source: await tokenAddress(source.address, config.mint),
      mint: address(config.mint),
      destination: await tokenAddress(buyerAddress, config.mint),
      authority: source,
      amount: P2P.docker.fundTokens,
      decimals: PAYMENT_LIMITS.tokenDecimals,
    }),
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
    (message) => setTransactionMessageFeePayerSigner(payer, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.blockhash),
          lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        },
        message,
      ),
    (message) => appendTransactionMessageInstructions(instructions, message),
  );
  const transaction = await signTransactionMessageWithSigners(message),
    signature = getSignatureFromTransaction(transaction);
  await saveJson(P2P.fundingJournal, {
    state: 'authorized',
    signature,
    buyer: buyerAddress,
    facilitator: feePayerAddress,
    mint: config.mint,
    lamports: P2P.docker.fundLamports.toString(),
    tokens: P2P.docker.fundTokens.toString(),
  });
  const sent = await rpc<string>(config.rpcUrl, 'sendTransaction', [
    getBase64EncodedWireTransaction(transaction),
    { encoding: 'base64', preflightCommitment: COMMITMENT },
  ]);
  assert.equal(sent, signature);
  await confirm(config.rpcUrl, signature);
  await saveJson(P2P.fundingJournal, { state: 'confirmed', signature });
  return { signature, mint: config.mint, payTo: config.addresses.seller };
}

export async function fundingConfig(operatorRoot: string) {
  const configPath = resolve(operatorRoot, CONFIG_PATH);
  const previous = process.env.GYBLOS_GATE_CONFIG;
  process.env.GYBLOS_GATE_CONFIG = configPath;
  let config: Config;
  try {
    config = await loadConfig();
  } finally {
    if (previous === undefined) delete process.env.GYBLOS_GATE_CONFIG;
    else process.env.GYBLOS_GATE_CONFIG = previous;
  }
  await assertProgram(config.rpcUrl);
  assert.equal(config.assetLabel, 'devnet-test-token');
  assert.equal(config.mint, config.addresses.mint);
  for (const role of ['buyer', 'facilitator'] as const) {
    assert.equal(
      resolve(config.keys[role]),
      resolve(dirname(configPath), keyFilename(role)),
    );
    const metadata = await lstat(config.keys[role]);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
    assert.equal(metadata.mode & P2P.permissionMask, FILE_MODES.privateFile);
  }
  return config;
}

export async function fundRoles(
  operatorRoot: string,
  buyerAddress: string,
  feePayerAddress: string,
) {
  return withExclusiveLock(P2P.fundingLock, () =>
    fundRolesUnlocked(operatorRoot, buyerAddress, feePayerAddress),
  );
}
