// `pnpm buyer` in paid mode: each startup refusal names its own static reason (model, network, tokenizer,
// wallet key, journal held by another buyer, unsafe API token), and a started buyer answers on the loopback
// endpoint only with the bearer token it keeps in the buyer home. A disposable home, a fake endpoint, an
// injected tokenizer and an RPC double; no network.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  link,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEVNET, DEVNET_GENESIS, ROLE_KEY_FILES } from '@gyblos/config';
import type { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const REFUSED = 'refuse me';
const SELECTION = {
  request: {
    selection: { modelId: 'qwen3-0.6b', variant: null, quantization: 'Q4_K_M' },
    reasoning: 'off',
    lowestReasoning: null,
    network: DEVNET,
    asset: MINT,
    maxTokens: 64,
    maxAtomic: '1000',
    priceCeilings: { inputAtomicPerMtok: '100', outputAtomicPerMtok: '100' },
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

// Counts a word per token; a prompt the chat template would refuse throws, as the real one does.
const meter = async () => ({
  count: (text: string) => text.split(/\s+/).filter(Boolean).length,
  input: (prompt: string) => {
    if (prompt === REFUSED) throw new Error('Unsupported prompt.');
    return 4;
  },
});

const rpc = (genesis: string) => ({
  getGenesisHash: () => ({ send: async () => genesis }),
  getLatestBlockhash: () => ({
    send: async (): Promise<never> => {
      throw new Error('no chain in this test');
    },
  }),
  getSlot: () => ({ send: async () => 0n }),
  getTransaction: () => ({
    send: async (): Promise<never> => {
      throw new Error('no chain in this test');
    },
  }),
});

void test('paid startup names each refusal and answers in paid mode once started', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-paid-start-'));
  process.env.GYBLOS_HOME = home;
  const buyer = join(home, 'buyer');
  const { startPaidBuyer } = await import('@gyblos/buyer/paid-startup');
  const { startupMessage, startupReason } =
    await import('@gyblos/buyer/free-main');
  const { buyerChainPayments } = await import('@gyblos/node/buyer-chain');
  const devnet = buyerChainPayments(
    async () => DEVNET_GENESIS,
    rpc(DEVNET_GENESIS),
  );
  const tokenFile = join(buyer, 'api-token');
  const secrets = [home];
  const reason = async (options: Parameters<typeof startPaidBuyer>[0]) => {
    try {
      const host = await startPaidBuyer(options);
      await host.close();
      return 'STARTED';
    } catch (error) {
      for (const secret of secrets)
        assert.equal(startupMessage(error).includes(secret), false);
      return startupReason(error);
    }
  };
  const ask = (url: string, authorization?: string) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify({
        model: 'qwen3-0.6b',
        messages: [{ role: 'user', content: REFUSED }],
      }),
      signal: AbortSignal.timeout(5000),
    });
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
    const { nodeId } = JSON.parse(
      await readFile(join(buyer, 'role.json'), 'utf8'),
    ) as { nodeId: string };
    const selection = join(buyer, 'selection.json');
    const write = (value: unknown) =>
      writeFile(selection, JSON.stringify(value));
    const base = { bind: fakeBind(nodeId), port: 0, meter, chain: devnet };

    await write({
      ...SELECTION,
      request: { ...SELECTION.request, maxAtomic: '0' },
    });
    await write(SELECTION);

    const changed = (request: Record<string, unknown>) =>
      write({ ...SELECTION, request: { ...SELECTION.request, ...request } });
    await changed({
      selection: { ...SELECTION.request.selection, modelId: 'other' },
    });
    assert.equal(await reason(base), 'BUYER_PAID_MODEL_UNSUPPORTED');
    await changed({ asset: SELECTION.sellers[0]!.owner });
    assert.equal(await reason(base), 'BUYER_PAYMENT_NETWORK_MISMATCH');
    await write(SELECTION);
    // The pinned tokenizer is not installed in this home.
    assert.equal(
      await reason({ ...base, meter: undefined }),
      'BUYER_TOKENIZER_UNAVAILABLE',
    );
    assert.equal(
      await reason({
        ...base,
        chain: buyerChainPayments(async () => 'mainnet', rpc('mainnet')),
      }),
      'BUYER_PAYMENT_NETWORK_MISMATCH',
    );

    // A refusal after the journal opened releases it for the next start.
    assert.equal(
      await reason({ ...base, bind: fakeBind('0'.repeat(64)) }),
      'BUYER_NODE_KEY_MISMATCH',
    );
    const host = await startPaidBuyer(base);
    let token = '';
    try {
      assert.equal(host.chat.maxAtomic, '1000');
      await writeFile(
        join(buyer, 'selection.json'),
        JSON.stringify({
          ...SELECTION,
          request: { ...SELECTION.request, maxAtomic: '1' },
        }),
      );
      assert.equal(host.chat.maxAtomic, '1000');
      await writeFile(join(buyer, 'selection.json'), JSON.stringify(SELECTION));
      // The first paid start creates a private bearer token in the buyer home.
      token = await readFile(tokenFile, 'utf8');
      secrets.push(token);
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
      // A second buyer cannot hold the same payment journal.
      assert.equal(await reason(base), 'BUYER_PAYMENT_JOURNAL_UNAVAILABLE');
      const refused = await ask(host.url);
      assert.equal(refused.status, 401);
      assert.equal(refused.headers.get('x-should-retry'), 'false');
      assert.equal(
        ((await refused.json()) as { error: { code: string } }).error.code,
        'PAID_BUYER_UNAUTHORIZED',
      );
      const response = await ask(host.url, `Bearer ${token}`);
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        'PAID_BUYER_UNSUPPORTED_INPUT',
      );
    } finally {
      await host.close();
    }
    // A restart keeps the same token.
    const again = await startPaidBuyer(base);
    try {
      assert.equal(await readFile(tokenFile, 'utf8'), token);
      assert.equal((await ask(again.url, `Bearer ${token}`)).status, 400);
    } finally {
      await again.close();
    }

    // The chat closes its HTTP listener before the read-only inspection and releases the journal after it.
    let inspectionUrl = '';
    let observed = false;
    let chainClosed = false;
    const inspectChain: typeof devnet = async (role, maxAtomic) => {
      const held = await devnet(role, maxAtomic);
      return {
        ...held,
        observe: async (digest) => {
          assert.equal(digest, 'ab'.repeat(32));
          await assert.rejects(fetch(inspectionUrl));
          assert.equal(chainClosed, false);
          observed = true;
          return { chargedAtomic: '7', refundedAtomic: '993' };
        },
        close: async () => {
          chainClosed = true;
          await held.close();
        },
      };
    };
    const inspectHost = await startPaidBuyer({ ...base, chain: inspectChain });
    inspectionUrl = inspectHost.url;
    assert.ok(inspectHost.inspectAndClose);
    assert.deepEqual(await inspectHost.inspectAndClose('ab'.repeat(32)), {
      chargedAtomic: '7',
      refundedAtomic: '993',
    });
    assert.equal(observed, true);
    assert.equal(chainClosed, true);

    // A token others could read, a link, or content that is not a token is refused, never repaired.
    await chmod(tokenFile, 0o644);
    assert.equal(await reason(base), 'BUYER_API_TOKEN_INVALID');
    await chmod(tokenFile, 0o600);
    await writeFile(tokenFile, 'short');
    assert.equal(await reason(base), 'BUYER_API_TOKEN_INVALID');
    await rm(tokenFile);
    const elsewhere = join(home, 'elsewhere');
    await writeFile(elsewhere, token, { mode: 0o600 });
    await symlink(elsewhere, tokenFile);
    assert.equal(await reason(base), 'BUYER_API_TOKEN_INVALID');
    await rm(tokenFile);
    // A second name elsewhere, a FIFO (which must not block the start) and an oversized file.
    await link(elsewhere, tokenFile);
    assert.equal(await reason(base), 'BUYER_API_TOKEN_INVALID');
    await rm(tokenFile);
    execFileSync('mkfifo', ['-m', '600', tokenFile]);
    assert.equal(await reason(base), 'BUYER_API_TOKEN_INVALID');
    await rm(tokenFile);
    await writeFile(tokenFile, `${token}\n`.repeat(8), { mode: 0o600 });
    assert.equal(await reason(base), 'BUYER_API_TOKEN_INVALID');
    // Removing it makes the next start generate a new one, and no staged file is left beside it.
    await rm(tokenFile);
    assert.equal(await reason(base), 'STARTED');
    assert.notEqual(await readFile(tokenFile, 'utf8'), token);
    assert.deepEqual(
      (await readdir(buyer)).filter((name) => name.startsWith('api-token')),
      ['api-token'],
    );

    await writeFile(join(buyer, ROLE_KEY_FILES.buyer), '[1,2,3]', {
      mode: 0o600,
    });
    assert.equal(await reason(base), 'BUYER_WALLET_KEY_INVALID');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
