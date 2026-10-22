// Owns a throwaway solana-test-validator cloned from public devnet (8004 program, mpl-core, registry configs).
// The clone source is fixed to devnet; it never connects to mainnet. Ledger and log stay under ignored .local/.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { createSolanaRpc } from '@solana/kit';

import { DEVNET_RPC_URL, FILE_MODES, LOCALHOST } from '@gyblos/config';
import { DEVNET_REGISTRY, PROGRAMS } from '@gyblos/identity/constants';

const VALIDATOR_BINARY = 'solana-test-validator';
// Synthetic local ports; the validator also binds RPC_PORT + 1 for websockets.
const RPC_PORT = 18899;
const FAUCET_PORT = 19900;
const STARTUP_POLLS = 120;
const POLL_MS = 500;
const LOCAL_DIR = new URL('../../.local/identity-validator/', import.meta.url);

export interface LocalValidator {
  url: string;
  stop(): void;
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

function validatorArgs(ledger: string): string[] {
  return [
    ...['--ledger', ledger, '--reset', '--quiet'],
    ...['--bind-address', LOCALHOST],
    ...['--rpc-port', String(RPC_PORT), '--faucet-port', String(FAUCET_PORT)],
    ...['--url', DEVNET_RPC_URL],
    ...['--clone-upgradeable-program', PROGRAMS.registry],
    ...['--clone-upgradeable-program', PROGRAMS.mplCore],
    ...['--clone', DEVNET_REGISTRY.rootConfig],
    ...['--clone', DEVNET_REGISTRY.registryConfig],
    ...['--clone', DEVNET_REGISTRY.collection],
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

export async function startLocalValidator(): Promise<ValidatorStart> {
  mkdirSync(LOCAL_DIR, { recursive: true, mode: FILE_MODES.privateDirectory });
  const log = openSync(
    new URL('validator.log', LOCAL_DIR),
    'w',
    FILE_MODES.privateFile,
  );
  const ledger = new URL('ledger', LOCAL_DIR).pathname;
  const url = `http://${LOCALHOST}:${RPC_PORT}`;
  const child = spawn(VALIDATOR_BINARY, validatorArgs(ledger), {
    stdio: ['ignore', log, log],
    // macOS tar would add AppleDouble "._" entries that break the genesis archive.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (!(await waitHealthy(child, url))) {
    child.kill('SIGTERM');
    return {
      ok: false,
      reason:
        'validator did not become healthy (devnet clone unreachable?); see .local/identity-validator/validator.log',
    };
  }
  return { ok: true, validator: { url, stop: () => child.kill('SIGTERM') } };
}
