// Checks the seller's escrow deposit guard: missing or short escrow blocks inference, and direct channel
// admission rejects absent, foreign, truncated or wrongly encoded accounts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
} from '@solana/kit';

import {
  CHANNEL_PROGRAM,
  DEVNET_GENESIS,
} from '@gyblos/payments-x402/constants';
import { verifyInferenceDeposit } from '@gyblos/payments-x402/inference-deposit';

const buyer = '5FVtvnKXCabCDxSoeNJuLdRpCTBZQnhTnNooZzEYfg2j';
const feePayer = 'HZLkSwMefjig2NhrKaW3Hb16JX8PTQnE4Jutdc2B433g';
const authorizer = '4hL4FcqMnrjMLnmyWzaSHhYiwV7FMjVr3CwnpehHNCV7';
const mint = '2vXUXK2rJTPtb7Wx9em4W9FdgtfD6HTnFxZz5oirLVcH';
async function fixture() {
  const enc = getAddressEncoder();
  const [channelId, bump] = await getProgramDerivedAddress({
    programAddress: address(CHANNEL_PROGRAM),
    seeds: [
      Buffer.from('channel'),
      enc.encode(address(buyer)),
      enc.encode(address(feePayer)),
      enc.encode(address(mint)),
      enc.encode(address(authorizer)),
      getU64Encoder().encode(1n),
      getU64Encoder().encode(1n),
    ],
  });
  const data = Buffer.alloc(256);
  data[0] = 1;
  data[1] = 1;
  data[2] = bump;
  data.writeBigUInt64LE(1n, 4);
  data.writeBigUInt64LE(100n, 12);
  data.writeUInt32LE(60, 52);
  for (const [owner, offset] of [
    [buyer, 88],
    [feePayer, 120],
    [authorizer, 152],
    [mint, 184],
    [feePayer, 216],
  ] as const)
    data.set(enc.encode(address(owner)), offset);
  data.writeBigUInt64LE(1n, 248);
  return {
    channelId,
    data,
    expected: {
      rpcUrl: 'http://fake-rpc',
      channelId,
      buyer,
      feePayer,
      authorizer,
      mint,
      ceiling: '100',
    },
  };
}
async function withChain(
  options: {
    escrow?: string;
    deposit?: bigint;
    missing?: boolean;
    status?: number;
    wrongMint?: boolean;
    directOnly?: boolean;
    wrongOwner?: boolean;
    invalidData?: boolean;
    oversized?: boolean;
    nonCanonical?: boolean;
    wrongEncoding?: boolean;
    wrongDiscriminator?: boolean;
    missingEscrow?: boolean;
    wrongEscrowOwner?: boolean;
  },
  run: (
    expected: Awaited<ReturnType<typeof fixture>>['expected'],
  ) => Promise<void>,
) {
  const f = await fixture();
  if (options.deposit !== undefined)
    f.data.writeBigUInt64LE(options.deposit, 12);
  if (options.status !== undefined) f.data[3] = options.status;
  if (options.wrongDiscriminator) f.data[0] = 0;
  const calls: { method: string; params: unknown[] }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push({ method, params });
    let result: unknown;
    if (method === 'getGenesisHash') result = DEVNET_GENESIS;
    else if (method === 'getProgramAccounts') {
      assert.equal(
        options.directOnly,
        undefined,
        'Channel admission must not scan program accounts',
      );
      result = options.missing
        ? []
        : [
            {
              pubkey: f.channelId,
              account: {
                owner: CHANNEL_PROGRAM,
                data: [f.data.toString('base64'), 'base64'],
              },
            },
          ];
    } else if (method === 'getAccountInfo' && params[0] === f.channelId) {
      assert.equal(params[1].encoding, 'base64');
      assert.equal(params[1].commitment, 'confirmed');
      const data = options.invalidData
        ? Buffer.alloc(2)
        : options.oversized
          ? Buffer.concat([f.data, Buffer.alloc(1)])
          : f.data;
      if (options.nonCanonical) data.writeBigUInt64LE(2n, 248);
      result = {
        value: options.missing
          ? null
          : {
              owner: options.wrongOwner
                ? TOKEN_PROGRAM_ADDRESS
                : CHANNEL_PROGRAM,
              data: [
                data.toString('base64'),
                options.wrongEncoding ? 'base58' : 'base64',
              ],
            },
      };
    } else if (method === 'getAccountInfo')
      result = {
        value: options.missingEscrow
          ? null
          : {
              owner: options.wrongEscrowOwner
                ? CHANNEL_PROGRAM
                : TOKEN_PROGRAM_ADDRESS,
              data: {
                parsed: {
                  info: {
                    owner: f.channelId,
                    mint: options.wrongMint ? buyer : mint,
                    tokenAmount: { amount: options.escrow ?? '100' },
                  },
                },
              },
            },
      };
    else throw new Error('Unexpected RPC method ' + method);
    return Response.json({ result });
  }) as typeof fetch;
  try {
    await run(f.expected);
    if (options.directOnly) {
      assert.ok(calls.every((call) => call.method !== 'getProgramAccounts'));
      const channelReads = calls.filter(
        (call) =>
          call.method === 'getAccountInfo' && call.params[0] === f.channelId,
      );
      assert.equal(
        channelReads.length,
        1,
        'Read exactly the requested channel',
      );
      assert.deepEqual(channelReads[0]!.params[1], {
        commitment: 'confirmed',
        encoding: 'base64',
      });
    }
  } finally {
    globalThis.fetch = original;
  }
}

void test('independent seller guard blocks inference on insufficient or missing escrow', async () => {
  for (const opts of [
    { escrow: '99' },
    { missing: true },
    { deposit: 99n },
    { status: 3 },
    { wrongMint: true },
  ]) {
    await withChain(opts, async (expected) => {
      let engineCalls = 0;
      await assert.rejects(async () => {
        await verifyInferenceDeposit(expected);
        engineCalls++;
      }, /deposit|escrow|channel/i);
      assert.equal(engineCalls, 0);
    });
  }
});
void test('independent seller guard accepts the committed deposit and harmless token donations', async () => {
  for (const escrow of ['100', '105'])
    await withChain({ escrow }, async (expected) => {
      await verifyInferenceDeposit(expected);
    });
});

void test('admission reads the requested channel directly, without scanning fee-payer channels', async () => {
  await withChain({ directOnly: true }, async (expected) =>
    verifyInferenceDeposit(expected),
  );
});

void test('direct admission rejects absent, foreign, truncated and noncanonical channel accounts', async () => {
  for (const options of [
    { missing: true },
    { wrongOwner: true },
    { invalidData: true },
    { nonCanonical: true },
    { oversized: true },
  ]) {
    await withChain({ ...options, directOnly: true }, async (expected) => {
      let engineCalls = 0;
      await assert.rejects(async () => {
        await verifyInferenceDeposit(expected);
        engineCalls++;
      });
      assert.equal(engineCalls, 0);
    });
  }
});

void test('direct admission rejects wrong encoding and channel discriminator before inference', async () => {
  for (const options of [
    { wrongEncoding: true },
    { wrongDiscriminator: true },
  ]) {
    await withChain({ ...options, directOnly: true }, async (expected) => {
      await assert.rejects(verifyInferenceDeposit(expected));
    });
  }
});

void test('direct admission retains canonical escrow owner and absence checks', async () => {
  for (const options of [{ missingEscrow: true }, { wrongEscrowOwner: true }]) {
    await withChain({ ...options, directOnly: true }, async (expected) => {
      await assert.rejects(verifyInferenceDeposit(expected), /escrow/i);
    });
  }
});
