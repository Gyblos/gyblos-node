// Protects the chain decoding (#349): real devnet transactions decode exactly (versions 0 and 1);
// vouchers count only when adjacent and for their own channel; failed or unreadable transactions never
// stop decoding; channel accounts are owner-checked; only safe RPC URLs are used. The scheduled read
// is covered by metrics-collector-chain-index.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  base58Decode,
  base58Encode,
} from '@gyblos/metrics-collector/chain/base58';
import { channelState } from '@gyblos/metrics-collector/chain/channel-account';
import {
  decodeTransaction,
  voucherOf,
} from '@gyblos/metrics-collector/chain/decode';
import { runChainIndex } from '@gyblos/metrics-collector/chain/indexer';
import {
  chainRpcUrl,
  createChainRpc,
} from '@gyblos/metrics-collector/chain/rpc';
import { CHAIN_INDEX } from '@gyblos/metrics-collector/constants';

import {
  fakeChainRpc,
  plainTx,
  PROGRAM,
  withSignature,
} from './support/metrics-collector-chain';
import { createCollectorD1 } from './support/metrics-collector-d1';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/chain/devnet-${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
const OPEN = fixture('open');
const SETTLE = fixture('seal-distribute');
const RECLAIM = fixture('reclaim');
const CHANNEL = 'EVQfRwtXxHj13yGVrbU8DnPLbvC1pNe2qxpMMZ3pR3jN';
const PAYER = 'DrmfjFNWzLDqDqUmxuFYWrfer2q2em89UpnLxqojnE9o';
const rowsOf = (
  database: ReturnType<typeof createCollectorD1>,
  query: string,
) => database.rows(query).map((row) => ({ ...row }));
const signatureOf = (tx: unknown) => decodeTransaction(tx).signature;
const lifecycle = () =>
  [RECLAIM, SETTLE, OPEN].map((tx) => ({ signature: signatureOf(tx), tx }));

void test('real devnet transactions decode to the channel lifecycle', () => {
  const [open] = decodeTransaction(OPEN).instructions;
  assert.deepEqual(
    [open!.kind, open!.channel, open!.payer, open!.amountAtomic, open!.salt],
    ['open', CHANNEL, PAYER, 10_000n, '3025764848692434101'],
  );
  assert.deepEqual(open!.recipients, [
    { owner: 'BJxYKSkMQmySQNNDSWcYNFdYWecGJpj7qnhtGc87Rga5', bps: 9709 },
    { owner: '4Ui1dfvqbFx9CtjXNcKajHdr7aKT1nbYRiYjB1s7umNy', bps: 291 },
  ]);
  const settle = decodeTransaction(SETTLE);
  assert.deepEqual(
    settle.instructions.map((entry) => [entry.kind, entry.cumulativeAtomic]),
    [
      ['settle_and_seal', 145n],
      ['distribute', null],
    ],
  );
  // What distribute actually moved: the settled 145 to the program treasury, the rest refunded.
  assert.deepEqual(
    settle.deltas.map((delta) => [delta.owner.slice(0, 4), delta.deltaAtomic]),
    [
      ['4zTe', 145n],
      ['Drmf', 9855n],
      ['EVQf', -10_000n],
    ],
  );
  assert.deepEqual(
    decodeTransaction(RECLAIM).instructions.map((entry) => entry.kind),
    ['reclaim'],
  );
  const v1 = decodeTransaction(fixture('v1-settle'));
  assert.deepEqual(
    v1.instructions.map((entry) => entry.kind),
    ['settle_and_seal', 'distribute'],
  );
});

void test('a voucher counts only when adjacent, for its channel, and when the seal carries one', () => {
  const data = new Uint8Array(16 + 50);
  new DataView(data.buffer).setUint16(10, 16, true);
  data.set([86, 1], 16);
  data.set(base58Decode(CHANNEL), 18);
  new DataView(data.buffer).setBigUint64(16 + 34, 777n, true);
  assert.deepEqual(voucherOf(data), {
    channel: CHANNEL,
    cumulativeAtomic: 777n,
  });
  const ed25519 = {
    programId: 'Ed25519SigVerify111111111111111111111111111',
    data: base58Encode(data),
    accounts: [],
  };
  const settle = {
    programId: PROGRAM,
    data: base58Encode(Uint8Array.from([2])),
    accounts: [CHANNEL, 'Sysvar'],
  };
  const memo = {
    programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    parsed: 'x',
  };
  const seal = (hasVoucher: number) => ({
    programId: PROGRAM,
    data: base58Encode(Uint8Array.from([4, hasVoucher])),
    accounts: ['Payee', CHANNEL, 'Sysvar'],
  });
  const cumulative = (instructions: unknown[]) =>
    decodeTransaction(plainTx('sig', instructions)).instructions.map(
      (entry) => entry.cumulativeAtomic,
    );
  assert.deepEqual(cumulative([ed25519, settle]), [777n]);
  assert.deepEqual(cumulative([ed25519, memo, settle]), [null]);
  assert.deepEqual(cumulative([ed25519, seal(1)]), [777n]);
  assert.deepEqual(cumulative([ed25519, seal(0)]), [null]);
  assert.equal(base58Encode(base58Decode(CHANNEL)), CHANNEL);
  assert.deepEqual(base58Decode('11'), Uint8Array.from([0, 0]));
  assert.throws(() => base58Decode('0OIl'), { name: 'Base58Error' });
});

void test('failed or unreadable program instructions never stop decoding', () => {
  const garbage = {
    programId: PROGRAM,
    data: base58Encode(Uint8Array.from([1])),
    accounts: [],
  };
  const failed = decodeTransaction(
    plainTx('failed', [garbage], { err: 'boom' }),
  );
  assert.deepEqual(
    [failed.failed, failed.instructions.length, failed.undecodable],
    [true, 0, 0],
  );
  const unreadable = decodeTransaction(plainTx('ok', [garbage]));
  assert.deepEqual(
    [unreadable.failed, unreadable.instructions.length, unreadable.undecodable],
    [false, 0, 1],
  );
});

void test('a channel account is read only when the program owns it', () => {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  bytes[3] = 1;
  view.setBigUint64(12, 10_000n, true);
  view.setBigUint64(20, 145n, true);
  view.setBigUint64(28, 100n, true);
  const data = btoa(String.fromCharCode(...bytes));
  assert.deepEqual(channelState({ owner: PROGRAM, data }), {
    status: 'sealed',
    depositAtomic: 10_000n,
    settledAtomic: 145n,
    payoutAtomic: 100n,
  });
  assert.equal(channelState({ owner: 'Other', data }).status, 'unknown');
  assert.equal(
    channelState({ owner: PROGRAM, data: btoa('short') }).status,
    'unknown',
  );
  assert.equal(channelState(null).status, 'closed');
});

void test('only an https (or loopback http) RPC URL without credentials is used', () => {
  assert.equal(chainRpcUrl('https://rpc.example/'), 'https://rpc.example/');
  // A known provider's mainnet host is read on its devnet host with the same path and key.
  assert.equal(
    chainRpcUrl('https://mainnet.helius-rpc.com/?api-key=k1'),
    'https://devnet.helius-rpc.com/?api-key=k1',
  );
  assert.equal(
    chainRpcUrl('https://solana-mainnet.g.alchemy.com/v2/k2'),
    'https://solana-devnet.g.alchemy.com/v2/k2',
  );
  assert.equal(chainRpcUrl('http://127.0.0.1:8899'), 'http://127.0.0.1:8899/');
  // Providers such as Helius carry the key in the query; the URL is never logged.
  assert.equal(
    chainRpcUrl('https://devnet.helius-rpc.example/?api-key=k'),
    'https://devnet.helius-rpc.example/?api-key=k',
  );
  for (const bad of [
    'http://rpc.example',
    'https://u:p@rpc.example',
    'https://rpc.example/#key',
    'nope',
    42,
  ])
    assert.equal(chainRpcUrl(bad), undefined, String(bad));
});

void test('the RPC client never follows a redirect, in a form Workers accepts', async () => {
  const seen: (RequestRedirect | undefined)[] = [];
  const rpc = createChainRpc('https://rpc.example/', (_input, init) => {
    seen.push(init?.redirect);
    return Promise.resolve(
      new Response(null, {
        status: 301,
        headers: { location: 'https://elsewhere.example/' },
      }),
    );
  });
  // Workers throws a TypeError on `redirect: 'error'`; `manual` keeps the 3xx, refused as not ok.
  await assert.rejects(rpc.signatures('address', {}), {
    name: 'ChainRpcError',
    reason: 'HTTP 301',
  });
  assert.deepEqual(seen, ['manual']);
});
