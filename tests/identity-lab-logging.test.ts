// Owns log-safety regressions for the identity lab devnet run; offline only.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SolanaError,
} from '@solana/kit';

import {
  airdropFailureReason,
  fundSponsor,
} from '../lab/tools/identity-devnet-run.js';

const SENTINEL = 'SYNTHETIC_CREDENTIAL_SENTINEL';
const CREDENTIALED_URL = `https://rpc.example.invalid/?api-key=${SENTINEL}`;
const LOW_BALANCE = 0n;

function thrownValues(): unknown[] {
  return [
    new Error(`request to ${CREDENTIALED_URL} failed`),
    new SolanaError(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, {
      __serverMessage: `upstream ${CREDENTIALED_URL}`,
    }),
    `plain string ${CREDENTIALED_URL}`,
    { message: CREDENTIALED_URL },
  ];
}

void test('faucet failures never print RPC error text or credentials', async () => {
  for (const thrown of thrownValues()) {
    const lines: string[] = [];
    const result = await fundSponsor({
      balance: async () => LOW_BALANCE,
      airdrop: async () => {
        throw thrown;
      },
      log: (line) => lines.push(line),
    });
    assert.equal(result, undefined);
    assert.equal(lines.length, 1);
    assert.ok(!lines.join('\n').includes(SENTINEL));
    assert.ok(!lines.join('\n').includes('rpc.example.invalid'));
  }
});

void test('the failure reason keeps only the numeric SDK error code', () => {
  const reason = airdropFailureReason(thrownValues()[1]);
  assert.ok(reason.includes(String(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR)));
  assert.ok(!reason.includes(SENTINEL));
  assert.equal(
    airdropFailureReason(new Error(CREDENTIALED_URL)),
    'SKIPPED devnet run: faucet refused airdrop',
  );
});
