// The registration RPC is bounded and refuses unrelated methods before making a request.
// Its fetch is synthetic and never reaches a network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { address, lamports } from '@solana/kit';

import * as rpcModule from '@gyblos/identity/resolution-rpc';

void test('registration RPC rejects oversized responses and disallowed methods', async () => {
  const create = Reflect.get(rpcModule, 'createIdentityRegistrationRpc');
  assert.equal(typeof create, 'function');
  let requests = 0;
  const rpc = create('https://rpc.example.invalid', {
    maxResponseBytes: 64,
    fetch: async () => {
      requests++;
      return new Response('x'.repeat(65));
    },
  });
  await assert.rejects(rpc.getGenesisHash().send());
  assert.equal(requests, 1);
  await assert.rejects(
    rpc
      .requestAirdrop(address('11111111111111111111111111111111'), lamports(1n))
      .send(),
  );
  assert.equal(requests, 1);
});
