// The @x402/svm patch's batch-settlement splits (proposed upstream as x402-foundation/x402#4166): a
// channel commits extra.splits at open only when the shape is valid and the buyer's integrator
// approved it, a channel without extra.splits keeps the SDK's 100% payTo, and every bundled copy of
// the helper (client, server and facilitator, ESM and CJS, root entry included) is the same code.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  generateKeyPairSigner,
  getAddressEncoder,
  type Address,
} from '@solana/kit';
import {
  BatchSvmScheme,
  buildDepositPayload,
} from '@x402/svm/batch-settlement/client';

import { TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';

const FULL = 10_000;
const FEE = 300;

type Split = { recipient: string; bps: number };
type Requirements = { payTo: string; extra?: Record<string, unknown> };
// The patch adds this method; the SDK's typings do not list it.
type PatchedScheme = {
  gyblosApprovedSplits(requirements: Requirements): Split[];
};
type Approve = (
  splits: readonly Split[],
  requirements: Requirements,
) => boolean;
type SchemeClass = new (
  signer: unknown,
  config: { approveSplits?: Approve },
) => unknown;
// The CJS root entry carries its own copy of the client scheme, patched like the subpath one.
const CJS_ROOT = (
  createRequire(import.meta.url)('@x402/svm') as {
    BatchSvmScheme: SchemeClass;
  }
).BatchSvmScheme;
const CLASSES = [BatchSvmScheme as unknown as SchemeClass, CJS_ROOT];

async function parties() {
  const [payTo, treasury] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const splits: Split[] = [
    { recipient: payTo.address, bps: FULL - FEE },
    { recipient: treasury.address, bps: FEE },
  ];
  return { payTo: payTo.address, splits };
}

// One client per bundled copy of the scheme (ESM subpath and CJS root).
async function schemes(approveSplits?: Approve) {
  const signer = await generateKeyPairSigner();
  return CLASSES.map(
    (Scheme) =>
      new Scheme(
        signer,
        approveSplits ? { approveSplits } : {},
      ) as PatchedScheme,
  );
}

void test('without extra.splits the channel pays 100% to payTo, with no approval needed', async () => {
  const { payTo } = await parties();
  for (const client of await schemes()) {
    assert.deepEqual(client.gyblosApprovedSplits({ payTo }), [
      { bps: FULL, recipient: payTo },
    ]);
    assert.deepEqual(
      client.gyblosApprovedSplits({
        payTo,
        extra: { tokenProgram: TOKEN_PROGRAM_ADDRESS },
      }),
      [{ bps: FULL, recipient: payTo }],
    );
  }
});

void test('a split channel is refused unless the integrator approves it', async () => {
  const { payTo, splits } = await parties();
  const requirements = { payTo, extra: { splits } };
  for (const client of [...(await schemes()), ...(await schemes(() => false))])
    assert.throws(
      () => client.gyblosApprovedSplits(requirements),
      /extra\.splits sends funds beyond payTo and was not approved/,
    );
  for (const approving of await schemes((received, offeredFor) => {
    assert.deepEqual(received, splits);
    assert.equal(offeredFor, requirements);
    return true;
  }))
    assert.deepEqual(approving.gyblosApprovedSplits(requirements), splits);
});

void test('a malformed extra.splits is refused even when approved', async () => {
  const { payTo, splits } = await parties();
  const [seller, fee] = splits as [Split, Split];
  const other = (await generateKeyPairSigner()).address;
  const cases: [unknown, RegExp][] = [
    [[], /1 to 4 recipients/],
    ['not a list', /1 to 4 recipients/],
    [Array.from({ length: 5 }, () => ({ ...fee, bps: FULL / 5 })), /1 to 4/],
    [[{ ...seller, bps: FULL - FEE - 1 }, fee], /sum to 10000/],
    [
      [
        { ...seller, bps: FULL },
        { ...fee, bps: 0 },
      ],
      /1 to 10000 bps/,
    ],
    [
      [
        { ...seller, bps: FULL - FEE - 0.5 },
        { ...fee, bps: FEE + 0.5 },
      ],
      /bps/,
    ],
    [[{ bps: FULL - FEE }, fee], /need a recipient/],
    [[{ recipient: other, bps: FULL - FEE }, fee], /must start with payTo/],
    [[fee, seller], /must start with payTo/],
    [[{ ...seller, bps: FULL - 2 * FEE }, fee, fee], /must be distinct/],
  ];
  for (const client of await schemes(() => true))
    for (const [value, expected] of cases)
      assert.throws(
        () => client.gyblosApprovedSplits({ payTo, extra: { splits: value } }),
        expected,
        JSON.stringify(value),
      );
});

void test('the approved splits reach the channel the buyer opens', async () => {
  const { payTo, splits } = await parties();
  const [payer, feePayer, receiverAuthorizer, mint] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const open = (recipients?: Split[]) =>
    buildDepositPayload({
      blockhash: {
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 1n,
      },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 100n,
      mint: mint.address,
      openSlot: 1n,
      payer,
      receiver: payTo as Address,
      receiverAuthorizer: receiverAuthorizer.address,
      salt: 7n,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
      ...(recipients ? { splits: recipients } : {}),
    } as unknown as Parameters<typeof buildDepositPayload>[0]);
  // The open instruction lists each recipient as a 32-byte key and a little-endian u16 share.
  const entry = ({ recipient, bps }: Split) =>
    Buffer.concat([
      Buffer.from(getAddressEncoder().encode(recipient as Address)),
      Buffer.from([bps % 256, Math.floor(bps / 256)]),
    ]);
  const transaction = async (recipients?: Split[]) =>
    Buffer.from((await open(recipients)).payload.deposit.transaction, 'base64');
  const plain = await transaction();
  assert.ok(plain.includes(entry({ recipient: payTo, bps: FULL })));
  const split = await transaction(splits);
  for (const share of splits) assert.ok(split.includes(entry(share)));
  assert.ok(!split.includes(entry({ recipient: payTo, bps: FULL })));
});

void test('every bundled copy of the patched splits helper is the same code', async () => {
  const entry = createRequire(import.meta.url).resolve('@x402/svm');
  const dist = dirname(dirname(entry));
  const files = [
    'esm/chunk-FVK5QHJM.mjs',
    'esm/batch-settlement/server/index.mjs',
    'esm/batch-settlement/facilitator/index.mjs',
    'cjs/batch-settlement/client/index.js',
    'cjs/batch-settlement/server/index.js',
    'cjs/batch-settlement/facilitator/index.js',
    'cjs/index.js',
  ];
  const bodies = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(dist, file), 'utf8');
      const match =
        /function gyblosBatchSplits\(requirements\) \{[\s\S]*?\n\}/.exec(text);
      assert.ok(match, `${file} carries gyblosBatchSplits`);
      return match[0].replace(/\s+/g, ' ');
    }),
  );
  for (const [index, body] of bodies.entries())
    assert.equal(body, bodies[0], String(files[index]));
});
