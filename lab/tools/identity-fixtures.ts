// Owns laboratory capture of public devnet 8004 account bytes for the identity golden decode tests.
// Read-only and devnet-only: refuses any RPC whose genesis is not devnet. Product code must not depend on this module.
import { writeFileSync } from 'node:fs';

import {
  createSolanaRpc,
  getBase64Decoder,
  getBase64Encoder,
} from '@solana/kit';

import { DEVNET_RPC_URL } from '@gyblos/config';
import { memcmpFilter } from '@gyblos/identity/codec';
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_OFFSETS,
  PROGRAMS,
} from '@gyblos/identity/constants';
import { assertDevnet } from '@gyblos/payments-x402/chain';

const FIXTURE = new URL(
  '../../tests/fixtures/identity-devnet-accounts.json',
  import.meta.url,
);
// Skip metadata entries with empty values so the fixture exercises a real value.
const MIN_METADATA_WITH_VALUE_BYTES = 60;
const JSON_INDENT = 2;
const BASE64_BYTES = getBase64Encoder();
const BASE64_TEXT = getBase64Decoder();

async function firstAccount(
  rpc: ReturnType<typeof createSolanaRpc>,
  discriminator: Uint8Array,
  preferWithValue: boolean,
) {
  const all = await rpc
    .getProgramAccounts(PROGRAMS.registry, {
      encoding: 'base64',
      filters: [memcmpFilter(ACCOUNT_OFFSETS.discriminator, discriminator)],
    })
    .send();
  const sorted = [...all].sort((left, right) =>
    left.pubkey < right.pubkey ? -1 : 1,
  );
  const pick = preferWithValue
    ? sorted.find(
        (item) =>
          BASE64_BYTES.encode(item.account.data[0]).length >
          MIN_METADATA_WITH_VALUE_BYTES,
      )
    : sorted[0];
  if (pick === undefined) throw new Error('no account found');
  return {
    address: pick.pubkey,
    owner: pick.account.owner,
    base64: BASE64_TEXT.decode(BASE64_BYTES.encode(pick.account.data[0])),
    total: all.length,
  };
}

async function main(): Promise<void> {
  await assertDevnet(DEVNET_RPC_URL);
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const agent = await firstAccount(rpc, ACCOUNT_DISCRIMINATORS.agent, false);
  const metadata = await firstAccount(
    rpc,
    ACCOUNT_DISCRIMINATORS.metadata,
    true,
  );
  const capture = {
    cluster: 'devnet',
    capturedAt: new Date().toISOString(),
    agent,
    metadata,
  };
  writeFileSync(FIXTURE, JSON.stringify(capture, null, JSON_INDENT) + '\n');
  console.log({ agents: agent.total, metadata: metadata.total });
}

await main();
