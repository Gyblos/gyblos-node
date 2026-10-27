// Actual loopback HTTP proves decoded compression limits, BigInt preservation and method restrictions.
// All bodies/accounts are synthetic; no external RPC, transaction or payment request is issued.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { address } from '@solana/kit';

import { IDENTITY_RPC_LIMITS } from '@gyblos/identity/constants';
import { createIdentityResolutionRpc } from '@gyblos/identity/resolution-rpc';

void test('gzip RPC overflow is measured after decompression even with a small content-length', async () => {
  const compressed = gzipSync(
    Buffer.alloc(IDENTITY_RPC_LIMITS.maxResponseBytes + 1, 32),
  );
  assert.ok(compressed.byteLength < IDENTITY_RPC_LIMITS.maxResponseBytes);
  const server = createServer((_request, response) => {
    response
      .writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': compressed.byteLength,
      })
      .end(compressed);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = server.address();
  assert.ok(target && typeof target !== 'string');
  try {
    await assert.rejects(
      createIdentityResolutionRpc(`http://127.0.0.1:${target.port}`)
        .getGenesisHash()
        .send(),
      { code: 'IDENTITY_RPC_RESPONSE_TOO_LARGE' },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
void test('bounded RPC retains SDK exact bigint decoding for finalized account reads', async () => {
  let body = '';
  const rpc = createIdentityResolutionRpc('https://rpc.invalid', {
    fetch: async (_url, init) => {
      body = String(init.body);
      const request: unknown = JSON.parse(body);
      assert.ok(request && typeof request === 'object' && 'id' in request);
      return new Response(
        `{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{"context":{"slot":9007199254740993},"value":[{"owner":"11111111111111111111111111111111","lamports":18446744073709551615,"rentEpoch":9007199254740995,"executable":false,"data":["AA==","base64"],"space":1}]}}`,
      );
    },
  });
  const result = await rpc
    .getMultipleAccounts([address('11111111111111111111111111111111')], {
      encoding: 'base64',
      commitment: 'finalized',
    })
    .send();
  assert.equal(result.context.slot, 9007199254740993n);
  assert.equal(result.value[0]!.lamports, 18446744073709551615n);
  const account = result.value[0];
  assert.ok(account && 'rentEpoch' in account);
  assert.equal(account.rentEpoch, 9007199254740995n);
  assert.equal(body.includes('getMultipleAccounts'), true);
});
void test('bounded identity RPC refuses non-read methods before transport even through an untyped caller', async () => {
  let calls = 0;
  const rpc = createIdentityResolutionRpc('https://rpc.invalid', {
    fetch: async () => {
      calls++;
      throw new Error('Must not fetch');
    },
  });
  const outsidePort = rpc as unknown as {
    sendTransaction(bytes: string): { send(): Promise<unknown> };
  };
  await assert.rejects(outsidePort.sendTransaction('synthetic').send(), {
    code: 'IDENTITY_RPC_REQUEST_INVALID',
  });
  assert.equal(calls, 0);
});
