// The withdrawal's instructions match the SDK's own builders byte for byte: request_close, seal and
// distribute with its accounts and recipient tail, the stored distribution hash and each network's
// program treasury. The SDK does not export these builders, so the test loads its chunk directly.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token';
import {
  AccountRole,
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  type AccountMeta,
} from '@solana/kit';
import { SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } from '@x402/svm';
import {
  distributeInstruction,
  payerTokenAccountInstruction,
  requestCloseInstruction,
  sealInstruction,
  tokenAccountInstruction,
  UPTO_PROGRAM,
  uptoDistributionHash,
  uptoProgramTreasury,
  uptoTokenAccount,
  type UptoProgramInstruction,
} from 'x402-upto-metered';

import { decodeSent, newAddress } from './support/upto-withdraw-chain';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNNbYQ6g6tYqhW1g6c4a76Gcv';

type Built = {
  programAddress: string;
  accounts: readonly AccountMeta[];
  data?: Iterable<number>;
};
interface SdkBuilders {
  buildSealInstruction(channelId: string): Built;
  buildDistributeInstruction(args: Record<string, unknown>): Promise<Built>;
  buildRequestCloseTransaction(args: Record<string, unknown>): Promise<string>;
  getChannelDistributionHash(
    splits: readonly { recipient: string; bps: number }[],
  ): Uint8Array;
  getPaymentChannelsTreasuryOwner(network: string): string;
  PAYMENT_CHANNELS_PROGRAM_ADDRESS: string;
}

// The SDK's ESM chunks that define these builders, found by their export list.
async function sdk(): Promise<SdkBuilders> {
  const entry = createRequire(
    new URL('../packages/x402-upto-metered/package.json', import.meta.url),
  ).resolve('@x402/svm');
  const esm = join(dirname(dirname(entry)), 'esm');
  const names: (keyof SdkBuilders)[] = [
    'buildSealInstruction',
    'buildDistributeInstruction',
    'buildRequestCloseTransaction',
    'getChannelDistributionHash',
    'getPaymentChannelsTreasuryOwner',
    'PAYMENT_CHANNELS_PROGRAM_ADDRESS',
  ];
  const found: Partial<Record<keyof SdkBuilders, unknown>> = {};
  for (const file of await readdir(esm)) {
    if (!file.endsWith('.mjs')) continue;
    const text = await readFile(join(esm, file), 'utf8');
    const wanted = names.filter((name) =>
      new RegExp(`export \\{[^}]*\\b${name}\\b`).test(text),
    );
    if (!wanted.length) continue;
    const loaded = (await import(
      pathToFileURL(join(esm, file)).href
    )) as Record<string, unknown>;
    // A later chunk re-exporting a name under an alias must not erase the first definition.
    for (const name of wanted) found[name] ??= loaded[name];
  }
  for (const name of names)
    assert.ok(found[name] !== undefined, `SDK export ${name}`);
  return found as unknown as SdkBuilders;
}

const view = (built: Built | UptoProgramInstruction) => ({
  program: String(built.programAddress),
  accounts: built.accounts.map(({ address: key, role }) => [String(key), role]),
  data: [...(built.data ?? [])],
});

void test('seal and distribute match the SDK builders, recipient tail included', async () => {
  const builders = await sdk();
  const channelId = await newAddress();
  assert.deepEqual(
    view(sealInstruction(channelId)),
    view(builders.buildSealInstruction(channelId)),
  );
  for (const network of [SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2]) {
    const parties = {
      channelId,
      payer: await newAddress(),
      payee: await newAddress(),
      rentPayer: await newAddress(),
      mint: await newAddress(),
      tokenProgram: TOKEN_PROGRAM,
      network,
      splits: [
        { recipient: await newAddress(), bps: 9700 },
        { recipient: await newAddress(), bps: 300 },
      ],
    };
    assert.deepEqual(
      view(await distributeInstruction(parties)),
      view(await builders.buildDistributeInstruction(parties)),
    );
  }
});

void test('request_close is the SDK instruction, signed by the payer', async () => {
  const builders = await sdk();
  const payer = await generateKeyPairSigner();
  const channelId = await newAddress();
  const wire = await builders.buildRequestCloseTransaction({
    payer,
    feePayer: await newAddress(),
    channelId,
    blockhash: {
      blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(3)),
      lastValidBlockHeight: 10n,
    },
    memo: 'close',
  });
  assert.equal(UPTO_PROGRAM.id, builders.PAYMENT_CHANNELS_PROGRAM_ADDRESS);
  const inspected = decodeSent(wire);
  assert.equal(
    inspected.signature,
    null,
    'SDK partial wire remains inspectable',
  );
  const [theirs] = inspected.instructions.filter(
    (ix) => ix.program === UPTO_PROGRAM.id,
  );
  const ours = requestCloseInstruction(payer, channelId);
  assert.deepEqual(
    { accounts: theirs?.accounts, data: theirs?.data },
    {
      accounts: ours.accounts.map(({ address: key }) => String(key)),
      data: [...ours.data],
    },
  );
  assert.deepEqual(
    ours.accounts.map(({ role }) => role),
    [AccountRole.READONLY_SIGNER, AccountRole.WRITABLE],
    'payer a read-only signer, channel writable',
  );
});

void test('the distribution hash and program treasuries are the SDK values', async () => {
  const builders = await sdk();
  const splits = [
    { recipient: await newAddress(), bps: 9700 },
    { recipient: await newAddress(), bps: 300 },
  ];
  assert.deepEqual(
    [...uptoDistributionHash(splits)],
    [...builders.getChannelDistributionHash(splits)],
  );
  for (const network of [SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2])
    assert.equal(
      uptoProgramTreasury(network),
      String(builders.getPaymentChannelsTreasuryOwner(network)),
    );
});

void test('the payer token account is created as @solana-program/token does it', async () => {
  const payer = await generateKeyPairSigner();
  const mint = await newAddress();
  const ours = await payerTokenAccountInstruction(payer, mint, TOKEN_PROGRAM);
  const [ata] = await findAssociatedTokenPda({
    owner: payer.address,
    mint,
    tokenProgram: address(TOKEN_PROGRAM),
  });
  assert.equal(ata, await uptoTokenAccount(payer.address, mint, TOKEN_PROGRAM));
  assert.deepEqual(
    view(ours),
    view(
      getCreateAssociatedTokenIdempotentInstruction({
        payer,
        ata,
        owner: payer.address,
        mint,
        tokenProgram: address(TOKEN_PROGRAM),
      }),
    ),
  );
});

void test('another owner’s token account, paid by the fee payer, is created as @solana-program/token does it', async () => {
  const feePayer = await generateKeyPairSigner();
  const owner = await newAddress();
  const mint = await newAddress();
  const [ata] = await findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: address(TOKEN_PROGRAM),
  });
  assert.deepEqual(
    view(await tokenAccountInstruction(feePayer, owner, mint, TOKEN_PROGRAM)),
    view(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: feePayer,
        ata,
        owner,
        mint,
        tokenProgram: address(TOKEN_PROGRAM),
      }),
    ),
  );
});
