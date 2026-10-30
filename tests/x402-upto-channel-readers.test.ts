// Reads upto channels through a minimal RPC: whether the seller's own channel exists, and whether a
// recorded claim attempt landed or the channel was sealed for another amount. Accounts are synthetic
// bytes in the program's layout at their canonical address, decoded by the SDK. No network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getArrayEncoder,
  getBase58Decoder,
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
  landed: readonly string[] = [],
): UptoChannelRpc {
  return {
    getAccountInfo: async (channelId) => accounts.get(channelId) ?? null,
    signaturesSucceeded: async (signatures) =>
      signatures.map((signature) => landed.includes(signature)),
  };
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

void test('only a channel of this seller exists; a plain account at the address does not', async () => {
  const open = await channel(UPTO_CHANNEL_ACCOUNT.statuses.OPEN, 0n);
  const readers = createUptoChannelReaders(
    rpc(
      new Map([
        [open.channelId, open.account],
        // A lamport transfer leaves a system-owned, empty account.
        [open.rentPayer, { owner: SYSTEM_PROGRAM, data: ['', 'base64'] }],
      ]),
    ),
    { network: NETWORK, rentPayer: open.rentPayer },
  );
  assert.equal(await readers.channelExists(open.channelId), true);
  assert.equal(await readers.channelExists(open.rentPayer), false);
  assert.equal(await readers.channelExists(String(await newAddress())), false);
  const foreign = createUptoChannelReaders(
    rpc(new Map([[open.channelId, open.account]])),
    { network: NETWORK, rentPayer: await newAddress() },
  );
  assert.equal(await foreign.channelExists(open.channelId), false);
});

void test('a recorded claim attempt that landed is the claim, even after the channel was closed', async () => {
  const sealed = await channel(UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED, 250n);
  const claim = { chargedAtomic: '250', attempts: ['first', 'second'] };
  for (const accounts of [
    new Map([[sealed.channelId, sealed.account]]),
    // Rent cleanup reclaimed the account; the transaction stays on record.
    new Map(),
  ]) {
    const readers = createUptoChannelReaders(rpc(accounts, ['second']), {
      network: NETWORK,
      rentPayer: sealed.rentPayer,
    });
    assert.deepEqual(await readers.settledClaim(sealed.channelId, claim), {
      transaction: 'second',
      chargedAtomic: '250',
    });
  }
});

void test('a channel sealed for another amount refuses the claim; for ours, without a known transaction, it is unknown', async () => {
  for (const status of [
    UPTO_CHANNEL_ACCOUNT.statuses.SEALED,
    UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED,
  ]) {
    const sealed = await channel(status, 0n);
    const readers = createUptoChannelReaders(
      rpc(new Map([[sealed.channelId, sealed.account]])),
      { network: NETWORK, rentPayer: sealed.rentPayer },
    );
    assert.deepEqual(
      await readers.settledClaim(sealed.channelId, {
        chargedAtomic: '250',
        attempts: ['lost'],
      }),
      { transaction: '', chargedAtomic: '0' },
    );
    assert.equal(
      await readers.settledClaim(sealed.channelId, {
        chargedAtomic: '0',
        attempts: [],
      }),
      undefined,
    );
  }
});

void test('an open, closing, missing or foreign channel is not settled', async () => {
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
  const claim = { chargedAtomic: '5', attempts: [] };
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
    assert.equal(await readers.settledClaim(channelId, claim), undefined);
  }
});

void test('the kit adapter reads base64 accounts and counts only confirmed, error-free signatures', async () => {
  const calls: unknown[] = [];
  const signatures = await Promise.all(
    Array.from({ length: 4 }, async (_value, index) =>
      // Any 64-byte base58 string is a well-formed signature.
      getBase58Decoder().decode(new Uint8Array(64).fill(index + 1)),
    ),
  );
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
    getSignatureStatuses: (sent, config) => ({
      send: async () => {
        calls.push(['statuses', sent, config]);
        return {
          value: [
            { err: null, confirmationStatus: 'finalized' },
            { err: null, confirmationStatus: 'processed' },
            {
              err: { InstructionError: [0, 'Custom'] },
              confirmationStatus: 'confirmed',
            },
            null,
          ],
        };
      },
    }),
  };
  const channels = uptoChannelRpc(kit);
  assert.deepEqual(await channels.getAccountInfo(PROGRAM), {
    owner: PROGRAM,
    data: ['AAEC', 'base64'],
  });
  assert.equal(await channels.getAccountInfo(String(await newAddress())), null);
  assert.deepEqual(await channels.signaturesSucceeded(signatures), [
    true,
    false,
    false,
    false,
  ]);
  assert.deepEqual(calls.at(-1), [
    'statuses',
    signatures,
    { searchTransactionHistory: true },
  ]);
  // A malformed signature is refused before any request.
  await assert.rejects(channels.signaturesSucceeded(['not a signature']));
});

void test('the channel state shows status, deposit and settled amount for reconciliation', async () => {
  const open = await channel(UPTO_CHANNEL_ACCOUNT.statuses.OPEN, 0n);
  const done = await channel(UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED, 250n);
  for (const [found, expected] of [
    [
      open,
      {
        status: UPTO_CHANNEL_ACCOUNT.statuses.OPEN,
        depositAtomic: '1000',
        settledAtomic: '0',
      },
    ],
    [
      done,
      {
        status: UPTO_CHANNEL_ACCOUNT.statuses.DISTRIBUTED,
        depositAtomic: '1000',
        settledAtomic: '250',
      },
    ],
  ] as const) {
    const readers = createUptoChannelReaders(
      rpc(new Map([[found.channelId, found.account]])),
      { network: NETWORK, rentPayer: found.rentPayer },
    );
    assert.deepEqual(await readers.channelState(found.channelId), expected);
    // Gone (closed and reclaimed) or never opened.
    assert.equal(
      await readers.channelState(String(await newAddress())),
      undefined,
    );
  }
});
