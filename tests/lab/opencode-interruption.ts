import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

import { batchSessionPathsIn } from '@gyblos/config';
import { channelBlockerMessage } from '@gyblos/node/buyer-channel-message';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  BUYER_KEY_CODES,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import {
  ENGINE_DONE_REASONS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { blockTestMeter } from '../support/batch-block-product';
import { paidSellerConfiguration } from '../support/paid-acceptance-config';
import { buyerClient } from '../support/session-product-client';
import { sessionProductHost } from '../support/session-product-host';

const binary = process.env.OPENCODE_BIN;
assert.ok(binary?.startsWith('/') && process.platform === 'darwin');
const home = await mkdtemp(join(tmpdir(), 'opencode-586-'));
const config = join(home, 'opencode.json');
const originalFetch = fetch;
const start = performance.now();
const now = () => Math.round(performance.now() - start);
const fragment = 'a'.repeat(64) + ' ';
const answer = 'The next answer arrived.';
let phase = 'warmup';
let cut = 0;
let partialRuns = 0;
const sandbox = [
  '-p',
  '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
];
let partialVisible = false;
let retries = 0;
let statusCode: unknown;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value))
    : {};
}
let generations = 0;
let session = '';
const host = await sessionProductHost(undefined, undefined, {
  contextTokens: 64000,
  maxTokens: 160,
  meter: { ...blockTestMeter, output: blockTestMeter.count },
  observe: () => {},
  generate: async (input) => {
    generations++;
    let text = answer;
    if (phase === 'interrupt' && partialRuns === 0) {
      partialRuns++;
      text = fragment + 'b'.repeat(62);
      await input.onText?.(fragment);
      await delay(1500, undefined, { signal: input.signal });
      await input.onText?.(text.slice(fragment.length));
    } else await input.onText?.(text);
    return {
      text,
      finishReason: ENGINE_DONE_REASONS.STOP,
      usage: {
        inputTokens: 2,
        outputTokens: text.length,
        totalDurationNs: 0,
        loadDurationNs: 0,
        inputDurationNs: 0,
        outputDurationNs: 0,
      },
    };
  },
});
const proxy = createServer(async (req, res) => {
  const signal = new AbortController();
  res.on('close', () => signal.abort());
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.url, '/v1/chat/completions');
    const response = await originalFetch(host.buyer().url, {
      method: 'POST',
      headers: {
        authorization: req.headers.authorization ?? '',
        'content-type': 'application/json',
      },
      body: Buffer.concat(chunks),
      signal: signal.signal,
    });
    statusCode = response.ok
      ? undefined
      : object(object(await response.clone().json()).error).code;
    console.log('HTTP', phase, now(), response.status, statusCode);
    res.writeHead(
      response.status,
      Object.fromEntries(
        [...response.headers].filter(
          ([name]) =>
            ![
              'connection',
              'keep-alive',
              'transfer-encoding',
              'content-length',
              'content-encoding',
            ].includes(name),
        ),
      ),
    );
    assert.ok(response.body);
    let seen = '';
    for await (const bytes of response.body) {
      res.write(bytes);
      seen += Buffer.from(bytes).toString();
      if (phase === 'interrupt' && !cut && seen.includes(fragment)) {
        assert.ok(!seen.includes('bbbbbbbb'));
        await delay(120);
        cut = now();
        console.log('CUT', cut, 'approvals', host.finance.approvals());
        res.destroy();
        signal.abort();
        return;
      }
    }
    res.end();
  } catch {
    res.destroy();
  }
});
try {
  const client = await buyerClient(host, originalFetch, '10000');
  const policy = parseBuyerApiPolicy(
    await (
      await client.owner(new URL(BUYER_API.STATUS_PATH, host.buyer().url))
    ).json(),
  );
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const addr = proxy.address();
  assert.ok(addr && typeof addr === 'object');
  await writeFile(
    config,
    JSON.stringify({
      enabled_providers: ['gyblos'],
      model: 'gyblos/' + policy.model,
      provider: {
        gyblos: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Gyblos',
          options: {
            baseURL: 'http://127.0.0.1:' + addr.port + '/v1',
            apiKey: client.delegated,
          },
          models: {
            [policy.model]: {
              name: policy.model,
              limit: { context: 64000, output: 160 },
            },
          },
        },
      },
      permission: { '*': 'deny' },
      agent: { build: { permission: { '*': 'deny' } } },
      tools: { '*': false },
    }),
    { mode: 0o600 },
  );
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    PATH: '/usr/bin:/bin',
    OPENCODE_CONFIG: config,
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_SHARE: 'true',
    TMPDIR: home,
  };
  console.log(
    'OpenCode',
    execFileSync('/usr/bin/sandbox-exec', [...sandbox, binary!, '--version'], {
      env,
      cwd: home,
      encoding: 'utf8',
    }).trim(),
  );
  for (const turn of ['warmup', 'interrupt', 'next', 'restarted', 'free']) {
    phase = turn;
    console.log('SEND', turn, now());
    const proc = spawn(
      '/usr/bin/sandbox-exec',
      [
        ...sandbox,
        binary!,
        'run',
        '--standalone',
        '--format',
        'json',
        ...(session ? ['--session', session] : []),
        'Synthetic question ' +
          (turn === 'free' || turn === 'restarted' ? 'next' : turn),
      ],
      { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const done = once(proc, 'close');
    proc.stderr.resume();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 55000);
    let complete = false;
    try {
      for await (const line of createInterface({ input: proc.stdout })) {
        const event = object(JSON.parse(line));
        if (typeof event.sessionID === 'string') {
          if (session) assert.equal(event.sessionID, session);
          session = event.sessionID;
        }
        const text = object(event.part).text;
        const partial =
          typeof text === 'string' && text.includes(fragment.trim());
        if (partial) partialVisible = true;
        if (event.type === 'retry') retries++;
        const visible = [BUYER_KEY_CODES.REVIEW, SESSION_CODES.STATUS_UNKNOWN]
          .map(channelBlockerMessage)
          .find((message) => line.includes(message));
        console.log(
          'CLIENT',
          turn,
          now(),
          event.type,
          text === answer ? 'complete answer' : partial ? 'partial answer' : '',
          visible ?? '',
        );
        if (event.type === 'text' && text === answer) complete = true;
      }
      const [exit, signal] = await done;
      const keys = parseBuyerApiKeysReply(
        await (
          await client.owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
        ).json(),
      );
      const key = keys.snapshot.keys[0];
      console.log('END', turn, now(), {
        exit,
        signal,
        complete,
        generations,
        deposits: host.finance.calls.filter((x) => x === 'deposit').length,
        approvals: host.finance.approvals(),
        blocked: keys.snapshot.blocked,
        reserved: key?.reservedAtomic,
        approved: key?.approvedAtomic,
      });
      if (turn === 'warmup' || turn === 'free') {
        assert.equal(exit, 0);
        assert.ok(complete);
      } else if (turn === 'next' || turn === 'restarted') {
        assert.equal(statusCode, SESSION_CODES.STATUS_UNKNOWN);
        assert.equal(generations, 3);
        assert.equal(exit, 1);
        assert.equal(keys.snapshot.blocked, false);
        if (turn === 'next') {
          await host.restartBuyer();
          continue;
        }
        await paidSellerConfiguration(OFFER_PRICING_KINDS.FREE);
        const path = process.env.GYBLOS_CONFIG!;
        await writeFile(
          path,
          (await readFile(path, 'utf8')).replace(
            'publish = true',
            'publish = false',
          ),
        );
        await host.restartBoth();
      } else {
        assert.ok(cut && partialVisible, 'No visible midway cut observed');
        assert.equal(exit, 1);
        assert.equal(retries, 1);
        assert.equal(statusCode, BUYER_KEY_CODES.REVIEW);
        assert.equal(keys.snapshot.blocked, true);
        assert.equal(generations, 3);
        const stored = await inspectBatchSession(
          batchSessionPathsIn(process.env, P2P_ROLES.SELLER),
        );
        assert.ok(stored?.snapshot.channelId);
        const { channelId, cumulativeAtomic } = stored.snapshot;
        host.finance.settled.set(channelId, {
          channelId,
          chargedAtomic: cumulativeAtomic,
          refundedAtomic: String(
            BigInt(stored.terms.depositAtomic) - BigInt(cumulativeAtomic),
          ),
          transaction: 'syntheticConfirmedClose',
        });
        const check = await client.owner(
          new URL(BUYER_API.RECONCILE_POOL_PATH, host.buyer().url),
          {
            method: 'POST',
            headers: { 'if-match': '"' + policy.policyId + '"' },
          },
        );
        console.log('CHECK', now(), check.status, 'settled', cumulativeAtomic);
        assert.equal(check.status, 204);
      }
      assert.ok(session);
      assert.equal(host.finance.calls.filter((x) => x === 'deposit').length, 1);
      if (turn === 'free') {
        assert.equal(generations, 4);
        assert.equal(host.finance.approvals(), 3);
        assert.equal(key?.reservedAtomic, '0');
        assert.equal(key?.settledAtomic, '136');
      }
    } finally {
      clearTimeout(timer);
    }
  }
} finally {
  proxy.closeAllConnections();
  proxy.close();
  await host.close();
  await rm(home, { recursive: true, force: true });
}
