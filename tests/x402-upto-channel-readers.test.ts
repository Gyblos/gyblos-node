// Reads upto channel accounts through a minimal RPC: existence, and the sealed amount with the sealing
// transaction. Accounts are synthetic bytes in the program's layout at their canonical address, decoded
// by the SDK's own decoder, so a layout mismatch fails here. No network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getArrayEncoder,
  getBase64Decoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getStructEncoder,
  getU8Encoder,
  getU32Encoder,
  getU64Encoder,
  getUtf8Encoder,
  type Address,
} from '@solana/kit';
import {
  createUptoChannelReaders,
  UPTO_CHANNEL_ACCOUNT,
  uptoChannelRpc,
  type UptoChannelRpc,
  type UptoKitRpc,
} from 'x402-upto-metered';

const PROGRAM = 'CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX';
const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const channelEncoder = getStructEncoder([
  ['discriminator', getU8Encoder()],
  ['version', getU8Encoder()],
  ['bump', getU8Encoder()],
  ['status', getU8Encoder()],
  ['salt', getU64Encoder()],
  ['deposit', getU64Encoder()],
  [
    'settlement',
    getStructEncoder([
      ['settled', getU64Encoder()],
      ['payoutWatermark', getU64Encoder()],
    ]),
  ],
  ['closureStartedAt', getI64Encoder()],
  ['payerWithdrawnAt', getI64Encoder()],
  ['gracePeriod', getU32Encoder()],
  ['distributionHash', getArrayEncoder(getU8Encoder(), { size: 32 })],
  ['payer', getAddressEncoder()],
  ['payee', getAddressEncoder()],
  ['authorizedSigner', getAddressEncoder()],
  ['mint', getAddressEncoder()],
  ['rentPayer', getAddressEncoder()],
  ['openSlot', getU64Encoder()],
]);

async function newAddress(): Promise<Address> {
  return (await generateKeyPairSigner()).address;
}

async function channel(status: number, settled: bigint) {
  const parties = {
    payer: await newAddress(),
    payee: await newAddress(),
    authorizedSigner: await newAddress(),
    mint: await newAddress(),
    rentPayer: await newAddress(),
  };
  const salt = 7n;
  const openSlot = 99n;
  const [channelId] = await getProgramDerivedAddress({
    programAddress: address(PROGRAM),
    seeds: [
      getUtf8Encoder().encode('channel'),
      getAddressEncoder().encode(parties.payer),
      getAddressEncoder().encode(parties.payee),
      getAddressEncoder().encode(parties.mint),
      getAddressEncoder().encode(parties.authorizedSigner),
      getU64Encoder().encode(salt),
      getU64Encoder().encode(openSlot),
    ],
  });
  const bytes = new Uint8Array(256);
  bytes.set(
    channelEncoder.encode({
      discriminator: 1,
      version: 1,
      bump: 255,
      status,
      salt,
      deposit: 1000n,
      settlement: { settled, payoutWatermark: settled },
      closureStartedAt: 0n,
      payerWithdrawnAt: 0n,
      gracePeriod: 60,
      distributionHash: Array.from({ length: 32 }, () => 0),
      ...parties,
      openSlot,
    }),
  );
  return {
    channelId: String(channelId),
    rentPayer: parties.rentPayer,
    account: {
      owner: PROGRAM,
      data: [getBase64Decoder().decode(bytes), 'base64'] as [string, 'base64'],
    },
  };
}

function rpc(
  accounts: Map<string, { owner: string; data: [string, 'base64'] }>,
  signatures: { signature: string; failed: boolean }[] = [],
): UptoChannelRpc {
  return {
    getAccountInfo: async (channelId) => accounts.get(channelId) ?? null,
    getSignatures: async () => signatures,
  };
}

void test('a channel exists exactly when its account does', async () => {
  const open = await channel(UPTO_CHANNEL_ACCOUNT.statuses.OPEN, 0n);
  const readers = createUptoChannelReaders(
    rpc(new Map([[open.channelId, open.account]])),
    { network: NETWORK, rentPayer: open.rentPayer },
  );
  assert.equal(await readers.channelExists(open.channelId), true);
  assert.equal(await readers.channelExists(await newAddress()), false);
});

void test('a sealed or distributed channel reports its settled amount and sealing transaction', async () => {
  for (const status of [
    UPTO_CHANNEL_ACCOUNT.statuses.SEALED,
    UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED,
  ]) {
    const sealed = await channel(status, 250n);
    // Newest first, as the chain returns them: distribute, seal, a failed claim, open.
    const readers = createUptoChannelReaders(
      rpc(new Map([[sealed.channelId, sealed.account]]), [
        { signature: 'distribute', failed: false },
        { signature: 'seal', failed: false },
        { signature: 'failed-claim', failed: true },
        { signature: 'open', failed: false },
      ]),
      { network: NETWORK, rentPayer: sealed.rentPayer },
    );
    assert.deepEqual(await readers.settledClaim(sealed.channelId), {
      transaction: 'seal',
      chargedAtomic: '250',
    });
  }
});

void test('an open, closing, missing, foreign or non-canonical channel is not sealed by a claim', async () => {
  const open = await channel(UPTO_CHANNEL_ACCOUNT.statuses.OPEN, 0n);
  const closing = await channel(UPTO_CHANNEL_ACCOUNT.statuses.CLOSING, 0n);
  const sealed = await channel(UPTO_CHANNEL_ACCOUNT.statuses.SEALED, 5n);
  const accounts = new Map([
    [open.channelId, open.account],
    [closing.channelId, closing.account],
    // A sealed account under another address than its own canonical one.
    [open.rentPayer, sealed.account],
    // The right bytes owned by another program.
    [
      sealed.channelId,
      { ...sealed.account, owner: String(await newAddress()) },
    ],
  ]);
  for (const [channelId, rentPayer] of [
    [open.channelId, open.rentPayer],
    [closing.channelId, closing.rentPayer],
    [String(await newAddress()), open.rentPayer],
    [open.rentPayer, sealed.rentPayer],
    [sealed.channelId, sealed.rentPayer],
  ] as const) {
    const readers = createUptoChannelReaders(rpc(accounts), {
      network: NETWORK,
      rentPayer,
    });
    assert.equal(await readers.settledClaim(channelId), undefined, channelId);
  }
  // Another rent payer's channel is not this seller's.
  const readers = createUptoChannelReaders(
    rpc(new Map([[sealed.channelId, sealed.account]])),
    { network: NETWORK, rentPayer: open.rentPayer },
  );
  assert.equal(await readers.settledClaim(sealed.channelId), undefined);
});

void test('a sealed channel without a sealing transaction is an error, never a guess', async () => {
  const sealed = await channel(UPTO_CHANNEL_ACCOUNT.statuses.SEALED, 5n);
  const readers = createUptoChannelReaders(
    rpc(new Map([[sealed.channelId, sealed.account]]), [
      { signature: 'open', failed: false },
    ]),
    { network: NETWORK, rentPayer: sealed.rentPayer },
  );
  await assert.rejects(readers.settledClaim(sealed.channelId));
});

void test('the kit adapter reads base64 accounts and marks failed signatures', async () => {
  const calls: unknown[] = [];
  const kit: UptoKitRpc = {
    getAccountInfo: (channel, config) => ({
      send: async () => {
        calls.push(['account', channel, config]);
        return {
          value:
            channel === address(PROGRAM)
              ? { owner: address(PROGRAM), data: ['AAEC', 'base64'] as const }
              : null,
        };
      },
    }),
    getSignaturesForAddress: (channel, config) => ({
      send: async () => {
        calls.push(['signatures', channel, config]);
        return [
          { signature: 'b', err: null },
          { signature: 'a', err: { InstructionError: [0, 'Custom'] } },
        ];
      },
    }),
  };
  const channels = uptoChannelRpc(kit);
  assert.deepEqual(await channels.getAccountInfo(PROGRAM), {
    owner: PROGRAM,
    data: ['AAEC', 'base64'],
  });
  assert.equal(await channels.getAccountInfo(String(await newAddress())), null);
  assert.deepEqual(await channels.getSignatures(PROGRAM), [
    { signature: 'b', failed: false },
    { signature: 'a', failed: true },
  ]);
  assert.deepEqual(calls.at(-1), [
    'signatures',
    address(PROGRAM),
    { limit: UPTO_CHANNEL_ACCOUNT.signatureLimit, commitment: 'confirmed' },
  ]);
});
