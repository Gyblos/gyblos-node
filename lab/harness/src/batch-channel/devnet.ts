// Devnet support for the batch-settlement channel check (founder-approved runs only): request spacing
// for the public RPC, persistent lab keys so leftover SOL is not lost, and funding from one funder key.
import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getTransferSolInstruction } from '@solana-program/system';
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';

import {
  DEVNET_GENESIS,
  FILE_MODES,
  HTTP_STATUS,
  labLayout,
} from '@gyblos/config';

import type { Chain } from './chain';

// The funder pays the mint and token accounts and tops up the facilitator, which pays every channel
// transaction; the buyer needs no SOL.
const FUNDER_MINIMUM = 50_000_000n;
const FACILITATOR_MINIMUM = 10_000_000n;
const FACILITATOR_TOP_UP = 20_000_000n;
const DEVNET_AIRDROP_LAMPORTS = 1_000_000_000;
// The public devnet RPC answers 429 under bursts: every request (the SDK's included) is spaced out
// and a 429 is retried after a growing pause.
const SPACING_MS = 250;
const RETRIES = 8;
const BACKOFF_MS = 2_000;
// An Ed25519 secret key as @solana/kit stores it: 32 private bytes, then the 32-byte public key.
const KEY_BYTES = 64;
const BYTE_MAX = 255;
const GROUP_OR_OTHER_ACCESS = 0o077;

// One key per party of the check; unrelated to the gate wallets in WALLET_ROLES.
const CHANNEL_CHECK_ROLES = [
  'funder',
  'facilitator',
  'buyer',
  'payTo',
  'receiverAuthorizer',
  'operator',
] as const;
type Role = (typeof CHANNEL_CHECK_ROLES)[number];

export async function signersByRole(
  make: (role: Role) => Promise<KeyPairSigner>,
) {
  const entries = await Promise.all(
    CHANNEL_CHECK_ROLES.map(async (role) => [role, await make(role)] as const),
  );
  return Object.fromEntries(entries) as Record<Role, KeyPairSigner>;
}

export function spaceDevnetRequests() {
  const plainFetch = globalThis.fetch;
  let last = 0;
  globalThis.fetch = async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + SPACING_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = Date.now();
      const response = await plainFetch(input, init);
      if (response.status !== HTTP_STATUS.tooManyRequests || attempt >= RETRIES)
        return response;
      await new Promise((resolve) =>
        setTimeout(resolve, BACKOFF_MS * (attempt + 1)),
      );
    }
  };
}

function newKeyBytes() {
  const { d, x } = generateKeyPairSync('ed25519').privateKey.export({
    format: 'jwk',
  });
  if (d === undefined || x === undefined)
    throw new Error('Ed25519 key export is incomplete');
  return [...Buffer.from(d, 'base64url'), ...Buffer.from(x, 'base64url')];
}

function keyBytes(stored: unknown, role: Role) {
  const value =
    typeof stored === 'object' && stored !== null
      ? (stored as Record<string, unknown>)[role]
      : undefined;
  if (
    !Array.isArray(value) ||
    value.length !== KEY_BYTES ||
    !value.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= BYTE_MAX,
    )
  )
    throw new Error(`batch-channel-check keys: ${role} is not a 64-byte key`);
  return Uint8Array.from(value as number[]);
}

// The funder has no devnet SOL and the faucet refused an airdrop; the entry exits with code 2.
export class FunderNeedsSolError extends Error {
  readonly exitCode = 2;
  constructor(funder: string) {
    super(
      `Fund the funder with about 0.1 devnet SOL at https://faucet.solana.com, then run again: ${funder}`,
    );
  }
}

// Devnet keys live in the lab home (0700 directory, 0600 file) and are reused across runs; a key
// file readable by anyone else is refused.
export async function devnetKeys(environment: NodeJS.ProcessEnv) {
  const path = labLayout(environment).batchChannelKeys;
  await mkdir(dirname(path), {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  let stored: unknown;
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & GROUP_OR_OTHER_ACCESS) !== 0)
      throw new Error(`${path} must be a regular file with mode 0600`);
    stored = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    stored = Object.fromEntries(
      CHANNEL_CHECK_ROLES.map((role) => [role, newKeyBytes()]),
    );
    await writeFile(path, JSON.stringify(stored), {
      flag: 'wx',
      mode: FILE_MODES.privateFile,
    });
  }
  return signersByRole((role) =>
    createKeyPairSignerFromBytes(keyBytes(stored, role)),
  );
}

export async function fundDevnet(
  chain: Chain,
  funder: KeyPairSigner,
  facilitator: KeyPairSigner,
) {
  if ((await chain.rpc<string>('getGenesisHash', [])) !== DEVNET_GENESIS)
    throw new Error('the RPC is not devnet');
  if ((await chain.solBalance(funder.address)) < FUNDER_MINIMUM) {
    try {
      await chain.airdrop(funder.address, DEVNET_AIRDROP_LAMPORTS);
    } catch {
      throw new FunderNeedsSolError(funder.address);
    }
  }
  if ((await chain.solBalance(facilitator.address)) < FACILITATOR_MINIMUM)
    await chain.send(funder, [
      getTransferSolInstruction({
        source: funder,
        destination: facilitator.address,
        amount: FACILITATOR_TOP_UP,
      }),
    ]);
}
