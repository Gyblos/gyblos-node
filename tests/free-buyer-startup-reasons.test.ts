// Each buyer:free startup refusal reports its own static reason, so a broken state file is never blamed
// on selection.json. In-process against a disposable home with a fake endpoint; no network or relay.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateKeyPairSigner } from '@solana/kit';

import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import type { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import { REPOSITORY_ROOT } from './support/node-config-fixtures.js';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SELECTION = {
  request: {
    selection: { modelId: 'qwen3-0.6b', variant: null, quantization: 'Q4_K_M' },
    reasoning: 'off',
    lowestReasoning: null,
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    asset: MINT,
    maxTokens: 64,
    maxAtomic: '0',
    priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
    minimumBadge: 'declared-usage',
    retention: ['none'],
  },
  sellers: [
    {
      owner: '4NxTufBox2MsDggn9yF2vEZ6TE55ZkcgoEY5Kuv1oRTP',
      nodeId:
        '5482bad2e0f534be4d92525ff99953bc146531e1696d43e92289f246ef0bd738',
      relayUrl: null,
      directAddresses: [],
    },
  ],
};

type Bound = Awaited<ReturnType<typeof bindEndpoint>>;
const fakeBind =
  (nodeId: string): typeof bindEndpoint =>
  async () =>
    ({
      id: () => ({ toString: () => nodeId }),
      close: async () => undefined,
    }) as unknown as Bound;

void test('buyer:free names state, role, key, reasoning and port failures separately', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-free-reasons-'));
  process.env.GYBLOS_HOME = home;
  const buyer = join(home, 'buyer');
  const { startFreeBuyer } = await import('@gyblos/buyer/free-startup');
  const { startupMessage, startupReason } =
    await import('@gyblos/buyer/free-main');
  const reason = async (options: Parameters<typeof startFreeBuyer>[0] = {}) => {
    try {
      const host = await startFreeBuyer(options);
      await host.close();
      return 'STARTED';
    } catch (error) {
      assert.equal(startupMessage(error).includes(home), false);
      return startupReason(error);
    }
  };
  const occupied = createServer();
  try {
    const setup = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/node/src/setup.ts',
        '--role',
        'buyer',
        '--mint',
        MINT,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          GYBLOS_HOME: home,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const role = await readFile(join(buyer, 'role.json'), 'utf8');
    const { nodeId } = JSON.parse(role) as { nodeId: string };
    const selection = join(buyer, 'selection.json');
    const write = (value: unknown) =>
      writeFile(selection, JSON.stringify(value));

    await write(SELECTION);
    await writeFile(join(buyer, 'selection-stats.json'), '{"rows":');
    assert.equal(
      await reason({ bind: fakeBind(nodeId) }),
      'SELECTION_STATS_INVALID',
    );
    await unlink(join(buyer, 'selection-stats.json'));

    await write({ ...SELECTION, discovery: {} });
    await writeFile(join(buyer, 'discovery-state-v2.json'), 'not json', {
      mode: 0o600,
    });
    assert.equal(
      await reason({ bind: fakeBind(nodeId) }),
      'DISCOVERY_STATE_UNAVAILABLE',
    );
    await unlink(join(buyer, 'discovery-state-v2.json'));

    await write({
      ...SELECTION,
      request: { ...SELECTION.request, reasoning: 'high' },
    });
    assert.equal(
      await reason({ bind: fakeBind(nodeId) }),
      'SELECTION_REASONING_UNSUPPORTED',
    );

    await write(SELECTION);
    assert.equal(
      await reason({ bind: fakeBind('ff'.repeat(32)) }),
      'BUYER_NODE_KEY_MISMATCH',
    );

    await new Promise<void>((resolve) =>
      occupied.listen(0, '127.0.0.1', resolve),
    );
    const port = (occupied.address() as { port: number }).port;
    assert.equal(
      await reason({ bind: fakeBind(nodeId), port }),
      'BUYER_PORT_IN_USE',
    );

    const key = await readFile(join(buyer, 'node.key'));
    await unlink(join(buyer, 'node.key'));
    assert.equal(
      await reason({ bind: fakeBind(nodeId) }),
      'BUYER_NODE_KEY_MISMATCH',
    );
    await writeFile(join(buyer, 'node.key'), key, { mode: 0o600 });

    const [owner, authorizer, facilitator, payTo] = await Promise.all(
      Array.from(
        { length: 4 },
        async () => (await generateKeyPairSigner()).address,
      ),
    );
    const seller = {
      ...(JSON.parse(role) as Record<string, unknown>),
      role: 'seller',
      assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
      owner,
      authorizer,
      facilitator,
      payTo,
    };
    await writeFile(join(buyer, 'role.json'), JSON.stringify(seller));
    assert.equal(
      await reason({ bind: fakeBind(nodeId) }),
      'BUYER_ROLE_NOT_BUYER',
    );

    await writeFile(join(buyer, 'role.json'), '{');
    assert.equal(
      await reason({ bind: fakeBind(nodeId) }),
      'BUYER_ROLE_INVALID',
    );
  } finally {
    occupied.close();
    delete process.env.GYBLOS_HOME;
    await rm(home, { recursive: true, force: true });
  }
});
