// Synthetic seller homes for the `gyblos seller status` tests: a role file, the daemon's status.json, signed
// receipts, an installed unit or agent and a fake service manager, index and clock. No real keys.
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { runCli } from '@gyblos/node-app/cli';
import type { StatusSystem } from '@gyblos/node-app/status-system';
import { openReceiptStore } from '@gyblos/node/receipts';
import { P2P_ROLES, RECEIPT_OUTCOMES } from '@gyblos/protocol/constants';
import {
  signSellerReceipt,
  type SellerReceiptV1,
} from '@gyblos/protocol/receipt';

import { receiptSigner, sellerRecord } from './receipt-fixture';

export const NOW = 1_800_000_000_000;
export const HOUR = 3_600_000;
export const OWNER = '11111111111111111111111111111112';
export const UNIT = '.config/systemd/user/gyblos-seller.service';
export const PLIST = 'Library/LaunchAgents/com.gyblos.seller.plist';

export interface Home {
  root: string;
  home: string;
  seller: string;
  account: string;
  nodeId: string;
  sign: ReturnType<typeof receiptSigner>['sign'];
}

export async function withHome(
  use: (home: Home) => Promise<void>,
  options: { role?: 'seller' | 'buyer' | false; nodeId?: string } = {},
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gyblos-status-'));
  const home = join(root, 'home');
  const seller = join(home, 'seller');
  const account = join(root, 'account');
  await mkdir(seller, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(seller, 0o700);
  await mkdir(account);
  const signer = receiptSigner();
  const nodeId = options.nodeId ?? signer.nodeId;
  const role = options.role ?? 'seller';
  if (role)
    await writeFile(
      join(seller, 'role.json'),
      JSON.stringify({
        schemaVersion: 1,
        role,
        rpcUrl: 'https://rpc.example.com',
        mint: OWNER,
        assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
        nodeId,
        ...(role === 'seller' ? { owner: OWNER } : { buyer: OWNER }),
      }),
    );
  try {
    await use({ root, home, seller, account, nodeId, sign: signer.sign });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function daemonStatus(home: Home, value: Record<string, unknown>) {
  await writeFile(join(home.seller, 'status.json'), JSON.stringify(value));
}

export async function daemonReady(home: Home, offers = [{ listed: true }]) {
  await writeFile(
    join(home.seller, 'status.json'),
    JSON.stringify({
      status: 'ready',
      role: 'seller',
      nodeId: home.nodeId,
      offers: offers.map((offer, index) => ({
        index,
        modelId: 'qwen3-0.6b',
        engine: 'ollama',
        listed: offer.listed,
      })),
    }),
  );
}

export async function installUnit(home: Home, path = UNIT) {
  await mkdir(join(home.account, path, '..'), { recursive: true });
  await writeFile(join(home.account, path), '');
}

export function system(
  home: Home,
  overrides: Partial<StatusSystem> = {},
): StatusSystem & { probes: string[][] } {
  const probes: string[][] = [];
  return {
    platform: 'linux',
    uid: 1000,
    accountHome: home.account,
    // An active unit, or a launch agent whose process runs.
    probe: async (argv) => {
      probes.push([...argv]);
      return {
        code: 0,
        output: argv[0] === 'launchctl' ? '\tstate = running\n' : '',
      };
    },
    daemonInContainer: async () => {
      throw new Error('not in a container in this test');
    },
    fetch: async () => {
      throw new Error('no network in this test');
    },
    now: () => NOW,
    probes,
    ...overrides,
  };
}

export async function status(
  home: Home,
  fake: StatusSystem,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(['seller', 'status', ...args], {
    env: { GYBLOS_HOME: home.home, ...env },
    cwd: home.root,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    status: fake,
  });
  const output = stdout + stderr;
  assert.equal(output.includes(home.home), false, output);
  return { code, stdout, stderr, output };
}

export async function storeReceipt(
  home: Home,
  index: number,
  fields: Partial<SellerReceiptV1>,
) {
  const record: SellerReceiptV1 = {
    ...sellerRecord(home.nodeId),
    requestId: index.toString(16).padStart(32, '0'),
    ...fields,
  };
  await openReceiptStore({
    environment: { GYBLOS_HOME: home.home },
    role: P2P_ROLES.SELLER,
    nodeId: home.nodeId,
    now: () => NOW,
  }).put({ seller: await signSellerReceipt(record, home.sign) });
}

export const at = (ageMs: number, totalMs = 40) => ({
  timing: { receivedAt: NOW - ageMs, firstTokenMs: 10, totalMs },
});
export const failed = (code: SellerReceiptV1['code']) => ({
  outcome: RECEIPT_OUTCOMES.FAILED,
  code,
  finishReason: null,
  usage: { inputTokens: 7, outputTokens: 0, reasoningTokens: null },
});
