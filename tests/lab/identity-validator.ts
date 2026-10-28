// Owns a throwaway solana-test-validator cloned from public devnet (8004 program, mpl-core, registry configs),
// optionally preloaded with synthetic accounts. Clone source is fixed to devnet; ledger and log stay in the lab home.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { createSolanaRpc } from '@solana/kit';

import {
  DEVNET_RPC_URL,
  FILE_MODES,
  labLayout,
  LOCALHOST,
} from '@gyblos/config';
import { DEVNET_REGISTRY, PROGRAMS } from '@gyblos/identity/constants';
import { assertLabHome } from '@gyblos/lab-harness/wallet';

import type { SyntheticChain } from '../support/identity-accounts';

const VALIDATOR_BINARY = 'solana-test-validator';
// Synthetic loopback ports kept inside 18000-19999: RPC (plus RPC_PORT + 1 for websockets), faucet, gossip
// and the dynamic range for TPU/TVU/repair, so the validator never reaches for its default 1024-65535 range.
const RPC_PORT = 18899;
const FAUCET_PORT = 19900;
const GOSSIP_PORT = 18001;
const DYNAMIC_PORT_RANGE = '18100-18200';
const STARTUP_POLLS = 120;
const POLL_MS = 500;

// Disposable validator scratch in the lab home, resolved when used.
function validatorDirectory() {
  return pathToFileURL(`${resolve(labLayout(process.env).identityValidator)}/`);
}

const PRELOAD_LAMPORTS = 10_000_000;

export interface LocalValidator {
  url: string;
  // Resolves once the validator process has exited.
  stop(): Promise<void>;
}

export type ValidatorStart =
  { ok: true; validator: LocalValidator } | { ok: false; reason: string };

// The integration clones public devnet accounts, so it is opt-in: the default
// suite stays offline. Probed once at registration time; false means run.
const OPT_IN_ENV = 'GYBLOS_IDENTITY_INTEGRATION';

function validatorSkip(): false | string {
  if (process.env[OPT_IN_ENV] !== '1')
    return `set ${OPT_IN_ENV}=1 to run identity integration (clones public devnet accounts)`;
  return spawnSync(VALIDATOR_BINARY, ['--version'], { stdio: 'ignore' })
    .status === 0
    ? false
    : `${VALIDATOR_BINARY} not found on PATH; identity integration not exercised`;
}

export const VALIDATOR_SKIP: false | string = validatorSkip();

// Writes each synthetic account as a `solana account --output json` file and returns --account flags.
function preloadArgs(chain: SyntheticChain): string[] {
  mkdirSync(new URL('accounts/', validatorDirectory()), {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  return [...chain].flatMap(([pubkey, account]) => {
    const file = new URL(`accounts/${pubkey}.json`, validatorDirectory())
      .pathname;
    const json = {
      pubkey,
      account: {
        lamports: PRELOAD_LAMPORTS,
        data: [Buffer.from(account.data).toString('base64'), 'base64'],
        owner: account.owner,
        executable: false,
        rentEpoch: 0,
        space: account.data.length,
      },
    };
    writeFileSync(file, JSON.stringify(json), { mode: FILE_MODES.privateFile });
    return ['--account', pubkey, file];
  });
}

function validatorArgs(ledger: string, preload: SyntheticChain): string[] {
  return [
    ...['--ledger', ledger, '--reset', '--quiet'],
    ...['--bind-address', LOCALHOST],
    ...['--rpc-port', String(RPC_PORT), '--faucet-port', String(FAUCET_PORT)],
    ...['--gossip-port', String(GOSSIP_PORT)],
    ...['--dynamic-port-range', DYNAMIC_PORT_RANGE],
    ...['--url', DEVNET_RPC_URL],
    ...['--clone-upgradeable-program', PROGRAMS.registry],
    ...['--clone-upgradeable-program', PROGRAMS.mplCore],
    ...['--clone', DEVNET_REGISTRY.rootConfig],
    ...['--clone', DEVNET_REGISTRY.registryConfig],
    ...['--clone', DEVNET_REGISTRY.collection],
    ...preloadArgs(preload),
  ];
}

async function waitHealthy(child: ChildProcess, url: string): Promise<boolean> {
  const rpc = createSolanaRpc(url);
  for (let poll = 0; poll < STARTUP_POLLS; poll += 1) {
    if (child.exitCode !== null) return false;
    try {
      if ((await rpc.getHealth().send()) === 'ok') return true;
    } catch {
      // Not listening yet; keep polling until the deadline.
    }
    await delay(POLL_MS);
  }
  return false;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

export async function startLocalValidator(
  preload: SyntheticChain = new Map(),
): Promise<ValidatorStart> {
  // Before the scratch mkdir, which would also create the lab home.
  await assertLabHome();
  mkdirSync(validatorDirectory(), {
    recursive: true,
    mode: FILE_MODES.privateDirectory,
  });
  const log = openSync(
    new URL('validator.log', validatorDirectory()),
    'w',
    FILE_MODES.privateFile,
  );
  const ledger = new URL('ledger', validatorDirectory()).pathname;
  const url = `http://${LOCALHOST}:${RPC_PORT}`;
  const child = spawn(VALIDATOR_BINARY, validatorArgs(ledger, preload), {
    stdio: ['ignore', log, log],
    // macOS tar would add AppleDouble "._" entries that break the genesis archive.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (!(await waitHealthy(child, url))) {
    await stopProcess(child);
    return {
      ok: false,
      reason:
        'validator did not become healthy (devnet clone unreachable?); see identity-validator/validator.log in the lab home',
    };
  }
  return { ok: true, validator: { url, stop: () => stopProcess(child) } };
}
