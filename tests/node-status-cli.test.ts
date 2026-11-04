// Owns the `gyblos seller status` contract: service state, the daemon's last written state, served offers,
// receipt counts over a day and a week, an optional index lookup, the RUNNING/STOPPED/STARTING/
// NOT_CONFIRMED result and exit codes, and that it writes nothing and prints no home location or buyer.
// Offline; a synthetic home, synthetic signed receipts and a fake service manager and index.
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { runCli } from '@gyblos/node-app/cli';
import type { StatusSystem } from '@gyblos/node-app/cli-status';
import { openReceiptStore } from '@gyblos/node/receipts';
import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION_CODES,
  P2P_ROLES,
  RECEIPT_OUTCOMES,
} from '@gyblos/protocol/constants';
import {
  signSellerReceipt,
  type SellerReceiptV1,
} from '@gyblos/protocol/receipt';

import {
  DISCOVERY_BASE,
  DISCOVERY_NOW,
  discoverySeller,
  fakeFetch,
  jsonResponse,
  sellersBody,
} from './support/discovery-fixture';
import { snapshot } from './support/doctor-fixture';
import { receiptSigner, sellerRecord } from './support/receipt-fixture';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const OWNER = '11111111111111111111111111111112';
const UNIT = '.config/systemd/user/gyblos-seller.service';
const PLIST = 'Library/LaunchAgents/com.gyblos.seller.plist';

interface Home {
  root: string;
  home: string;
  seller: string;
  account: string;
  nodeId: string;
  sign: ReturnType<typeof receiptSigner>['sign'];
}

async function withHome(
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

async function daemonReady(home: Home, offers = [{ listed: true }]) {
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

async function installUnit(home: Home, path = UNIT) {
  await mkdir(join(home.account, path, '..'), { recursive: true });
  await writeFile(join(home.account, path), '');
}

function system(
  home: Home,
  overrides: Partial<StatusSystem> = {},
): StatusSystem & { probes: string[][] } {
  const probes: string[][] = [];
  return {
    platform: 'linux',
    uid: 1000,
    accountHome: home.account,
    probe: async (argv) => {
      probes.push([...argv]);
      return 0;
    },
    fetch: async () => {
      throw new Error('no network in this test');
    },
    now: () => NOW,
    probes,
    ...overrides,
  };
}

async function status(
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

async function storeReceipt(
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

const at = (ageMs: number, totalMs = 40) => ({
  timing: { receivedAt: NOW - ageMs, firstTokenMs: 10, totalMs },
});
const failed = (code: SellerReceiptV1['code']) => ({
  outcome: RECEIPT_OUTCOMES.FAILED,
  code,
  finishReason: null,
  usage: { inputTokens: 7, outputTokens: 0, reasoningTokens: null },
});

void test('seller status: an active service with a ready daemon is RUNNING, with its receipts counted by day and week', () =>
  withHome(async (home) => {
    await daemonReady(home);
    await installUnit(home);
    await storeReceipt(home, 1, at(HOUR));
    await storeReceipt(home, 2, at(2 * 24 * HOUR));
    await storeReceipt(home, 3, {
      ...at(3 * HOUR),
      ...failed(FREE_EXECUTION_CODES.TIMEOUT),
    });
    await storeReceipt(home, 4, {
      ...at(30 * HOUR),
      outcome: RECEIPT_OUTCOMES.CANCELLED,
      code: FREE_EXECUTION_CODES.CANCELLED,
      finishReason: null,
    });
    await storeReceipt(home, 5, {
      ...at(8 * 24 * HOUR),
      finishReason: ENGINE_DONE_REASONS.STOP,
    });
    const fake = system(home);
    const result = await status(home, fake);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(fake.probes, [
      ['systemctl', '--user', 'is-active', '--quiet', 'gyblos-seller.service'],
    ]);
    assert.match(result.stdout, new RegExp(`^Seller ${home.nodeId}$`, 'm'));
    assert.match(result.stdout, new RegExp(`owner\\s+${OWNER}`));
    assert.match(result.stdout, /service\s+active/);
    assert.match(
      result.stdout,
      /daemon\s+ready, written \d{4}-\d\d-\d\dT[\d:]+Z/,
    );
    assert.match(result.stdout, /offer\s+qwen3-0\.6b via ollama: serving/);
    assert.match(result.stdout, /discovery\s+off/);
    assert.match(
      result.stdout,
      /last 24h\s+1 completed, 1 failed, 0 cancelled; 5 output tokens/,
    );
    assert.match(
      result.stdout,
      /last 7 days\s+2 completed, 1 failed, 1 cancelled; 15 output tokens/,
    );
    assert.match(
      result.stdout,
      new RegExp(
        `last request\\s+${new Date(NOW - HOUR).toISOString().replace(/\.\d+Z$/, 'Z')}`,
      ),
    );
    assert.match(
      result.stdout,
      /code\s+FREE_EXECUTION_CANCELLED x1\n\s+code\s+FREE_EXECUTION_TIMEOUT x1/,
    );
    assert.match(result.stdout, /^Result: RUNNING$/m);
    // No buyer, request or prompt detail.
    assert.doesNotMatch(result.output, /22{8}|synthetic\/model/);
  }));

void test('seller status: an inactive service is STOPPED and a starting daemon under an active one is STARTING', () =>
  withHome(async (home) => {
    await daemonReady(home);
    await installUnit(home);
    const stopped = await status(home, system(home, { probe: async () => 3 }));
    assert.equal(stopped.code, 1);
    assert.match(stopped.stdout, /service\s+inactive/);
    assert.match(stopped.stdout, /^Result: STOPPED$/m);
    await writeFile(
      join(home.seller, 'status.json'),
      JSON.stringify({ status: 'starting', phase: 'engines' }),
    );
    const starting = await status(home, system(home));
    assert.equal(starting.code, 1);
    assert.match(starting.stdout, /daemon\s+starting \(engines\)/);
    assert.match(starting.stdout, /^Result: STARTING$/m);
  }));

void test('seller status: without a service the result is NOT_CONFIRMED, and macOS asks launchd', () =>
  withHome(async (home) => {
    await daemonReady(home);
    const fake = system(home);
    const result = await status(home, fake);
    assert.equal(result.code, 1);
    assert.deepEqual(fake.probes, []);
    assert.match(result.stdout, /service\s+not installed/);
    assert.match(result.stdout, /^Result: NOT_CONFIRMED$/m);
    assert.match(result.stdout, /a stopped seller may still read "ready"/);

    await installUnit(home, PLIST);
    const mac = system(home, { platform: 'darwin', uid: 501 });
    const loaded = await status(home, mac);
    assert.equal(loaded.code, 0, loaded.output);
    assert.deepEqual(mac.probes, [
      ['launchctl', 'print', 'gui/501/com.gyblos.seller'],
    ]);
    const other = await status(home, system(home, { platform: 'win32' }));
    assert.match(other.stdout, /service\s+unknown/);
  }));

void test('seller status: a seller that never ran or stored a receipt reports so and nothing is created', () =>
  withHome(async (home) => {
    const before = await snapshot(home.root);
    const result = await status(home, system(home));
    assert.equal(result.code, 1);
    assert.match(result.stdout, /daemon\s+never started in this home/);
    assert.match(
      result.stdout,
      /last 7 days\s+0 completed, 0 failed, 0 cancelled; 0 output tokens/,
    );
    assert.match(result.stdout, /last request\s+none/);
    assert.deepEqual(await snapshot(home.root), before);
    assert.deepEqual(await readdir(home.seller), ['role.json']);
  }));

void test('seller status: an unexpected status file or receipt file is reported without echoing it', () =>
  withHome(async (home) => {
    await writeFile(
      join(home.seller, 'status.json'),
      JSON.stringify({
        status: 'ready',
        offers: [{ modelId: 'x y\u001b[2J', engine: 'ollama', listed: true }],
      }),
    );
    await mkdir(join(home.seller, 'receipts'), { mode: 0o700 });
    await writeFile(
      join(home.seller, 'receipts', 'receipts-v1.json'),
      '{"secret prompt":1}\n',
      { mode: 0o600 },
    );
    const result = await status(home, system(home));
    assert.match(result.stdout, /daemon\s+status file unreadable/);
    assert.match(result.stdout, /receipts\s+unavailable/);
    assert.doesNotMatch(result.output, /x y|\u001b|secret prompt/);
  }));

void test('seller status: a missing, buyer or unreadable role exits 1 with a code', async () => {
  await withHome(
    async (home) => {
      const result = await status(home, system(home));
      assert.equal(result.code, 1);
      assert.match(result.stderr, /^STATUS_ROLE_MISSING: /);
    },
    { role: false },
  );
  await withHome(
    async (home) => {
      const result = await status(home, system(home));
      assert.equal(result.code, 1);
      assert.match(result.stderr, /^STATUS_ROLE_NOT_SELLER: /);
    },
    { role: 'buyer' },
  );
});

void test('seller status --online pages the index for the served model until it finds this NodeId', async () => {
  const listed = await discoverySeller({ modelId: 'qwen3-0.6b' });
  const other = await discoverySeller({ modelId: 'qwen3-0.6b' });
  await withHome(
    async (home) => {
      await daemonReady(home);
      await writeFile(
        join(home.root, 'gyblos.toml'),
        `version = 1\n[node]\nnetwork = "devnet"\n[discovery]\npublish = true\nurl = "${DISCOVERY_BASE}"\n`,
      );
      const index = fakeFetch((call) =>
        jsonResponse(
          200,
          call.url.includes('cursor=')
            ? sellersBody([listed.entry])
            : sellersBody([other.entry], 'page2'),
        ),
      );
      const fake = system(home, {
        fetch: index.fetch,
        now: () => DISCOVERY_NOW,
      });
      const offline = await status(home, fake);
      assert.equal(index.calls.length, 0);
      assert.match(
        offline.stdout,
        /discovery\s+on \(https:\/\/index\.test <path hidden>\)\n/,
      );
      const online = await status(home, fake, ['--online']);
      assert.equal(index.calls.length, 2);
      assert.match(online.stdout, /; listed in the index/);
      const down = await status(home, system(home), ['--online']);
      assert.match(down.stdout, /; index unreachable/);
    },
    { nodeId: listed.catalog.nodeId },
  );
});

void test('seller status refuses flags of other commands', () =>
  withHome(async (home) => {
    for (const args of [
      ['--force'],
      ['--dry-run'],
      ['--config', 'x'],
      ['extra'],
    ]) {
      const result = await status(home, system(home), args);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, /^Usage:/, args.join(' '));
    }
  }));
