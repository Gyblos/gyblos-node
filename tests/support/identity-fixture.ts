// Owns deterministic identity test signers, hex helpers and the public devnet account fixture.
// No network, funded wallets or private keys: seeds are fixed synthetic bytes.
import { readFileSync } from 'node:fs';

import { createKeyPairFromPrivateKeyBytes } from '@solana/kit';

import {
  detachedSignerFromKeyPair,
  type DetachedSigner,
} from '@gyblos/identity';

const SEED_BYTES = 32;

export interface FixtureAccount {
  address: string;
  owner: string;
  base64: string;
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

export async function fixedSigner(fill: number): Promise<DetachedSigner> {
  const keyPair = await createKeyPairFromPrivateKeyBytes(
    new Uint8Array(SEED_BYTES).fill(fill),
  );
  return detachedSignerFromKeyPair(keyPair);
}

function fixtureAccount(value: unknown): FixtureAccount {
  if (typeof value !== 'object' || value === null)
    throw new Error('fixture: not an object');
  const fields = new Map(Object.entries(value));
  const read = (name: string) => {
    const field = fields.get(name);
    if (typeof field !== 'string') throw new Error(`fixture: ${name} missing`);
    return field;
  };
  return {
    address: read('address'),
    owner: read('owner'),
    base64: read('base64'),
  };
}

export function devnetAccounts(): {
  agent: FixtureAccount;
  metadata: FixtureAccount;
} {
  const parsed: unknown = JSON.parse(
    readFileSync(
      new URL('../fixtures/identity-devnet-accounts.json', import.meta.url),
      'utf8',
    ),
  );
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('fixture: not an object');
  const fixtures = new Map(Object.entries(parsed));
  return {
    agent: fixtureAccount(fixtures.get('agent')),
    metadata: fixtureAccount(fixtures.get('metadata')),
  };
}
