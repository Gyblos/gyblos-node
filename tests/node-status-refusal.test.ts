// Owns what `gyblos seller status` does with inputs it cannot trust or use: a missing, buyer or corrupt role,
// an unexpected status.json (including a FIFO, which must not hang it) or receipt file, an invalid or
// missing configuration, the --online index lookup and its failure modes, and other commands' flags.
// Offline; synthetic homes, a fake index and a fake service manager.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  DISCOVERY_BASE,
  DISCOVERY_NOW,
  discoverySeller,
  fakeFetch,
  jsonResponse,
  sellersBody,
} from './support/discovery-fixture';
import {
  daemonReady,
  status,
  system,
  withHome,
} from './support/status-fixture';

const PUBLISH = `version = 1\n[node]\nnetwork = "devnet"\n[discovery]\npublish = true\nurl = "${DISCOVERY_BASE}"\n`;

void test('seller status: a missing, buyer or unreadable role exits 1 with a STATUS code', async () => {
  for (const [role, code] of [
    [false, 'STATUS_ROLE_MISSING'],
    ['buyer', 'STATUS_ROLE_NOT_SELLER'],
  ] as const)
    await withHome(
      async (home) => {
        const result = await status(home, system(home));
        assert.equal(result.code, 1);
        assert.match(result.stderr, new RegExp(`^${code}: `));
        assert.equal(result.stdout, '');
      },
      { role },
    );
  await withHome(async (home) => {
    await writeFile(join(home.seller, 'role.json'), '{not json');
    const result = await status(home, system(home));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^STATUS_ROLE_UNREADABLE: /);
  });
});

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
    // Neither a FIFO nor an oversized file is read.
    await rm(join(home.seller, 'status.json'));
    execFileSync('mkfifo', [join(home.seller, 'status.json')]);
    const fifo = await status(home, system(home));
    assert.match(fifo.stdout, /daemon\s+status file unreadable/);
    await rm(join(home.seller, 'status.json'));
    await writeFile(join(home.seller, 'status.json'), ' '.repeat(65 * 1024));
    const large = await status(home, system(home));
    assert.match(large.stdout, /daemon\s+status file unreadable/);
  }));

void test('seller status: a configuration node:start would refuse is reported, not replaced by defaults', () =>
  withHome(async (home) => {
    await writeFile(join(home.root, 'gyblos.toml'), 'version = "x"\n');
    const invalid = await status(home, system(home));
    assert.match(invalid.stdout, /discovery\s+configuration invalid/);
    await rm(join(home.root, 'gyblos.toml'));
    const missing = await status(home, system(home), [], {
      GYBLOS_CONFIG: 'absent.toml',
    });
    assert.match(missing.stdout, /discovery\s+configuration invalid/);
    // Only a missing implicit ./gyblos.toml falls back to the defaults.
    const implicit = await status(home, system(home));
    assert.match(implicit.stdout, /discovery\s+off/);
  }));

void test('seller status --online pages the index for the served model until it finds this NodeId', async () => {
  const listed = await discoverySeller({ modelId: 'qwen3-0.6b' });
  const other = await discoverySeller({ modelId: 'qwen3-0.6b' });
  await withHome(
    async (home) => {
      await daemonReady(home);
      await writeFile(join(home.root, 'gyblos.toml'), PUBLISH);
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
      // Only the model goes to the index, never the NodeId.
      for (const call of index.calls)
        assert.equal(call.url.includes(home.nodeId), false);
      assert.match(online.stdout, /; listed in the index/);
      const down = await status(home, system(home), ['--online']);
      assert.match(down.stdout, /; index unreachable/);
    },
    { nodeId: listed.catalog.nodeId },
  );
});

void test('seller status --online says when it found nothing, stopped paging or had nothing to look up', async () => {
  const other = await discoverySeller({ modelId: 'qwen3-0.6b' });
  await withHome(async (home) => {
    await writeFile(join(home.root, 'gyblos.toml'), PUBLISH);
    const once = fakeFetch(() => jsonResponse(200, sellersBody([other.entry])));
    await daemonReady(home);
    const absent = await status(
      home,
      system(home, { fetch: once.fetch, now: () => DISCOVERY_NOW }),
      ['--online'],
    );
    assert.match(absent.stdout, /; not found in the index/);
    const endless = fakeFetch(() =>
      jsonResponse(200, sellersBody([other.entry], 'more')),
    );
    const truncated = await status(
      home,
      system(home, { fetch: endless.fetch, now: () => DISCOVERY_NOW }),
      ['--online'],
    );
    assert.equal(endless.calls.length, 10);
    assert.match(
      truncated.stdout,
      /; not in the first 2000 sellers of the index/,
    );
    await daemonReady(home, [{ listed: false }]);
    const idle = fakeFetch(() => jsonResponse(200, sellersBody([])));
    const nothing = await status(
      home,
      system(home, { fetch: idle.fetch, now: () => DISCOVERY_NOW }),
      ['--online'],
    );
    assert.equal(idle.calls.length, 0);
    assert.match(nothing.stdout, /; not looked up: no offer is serving yet/);
  });
});

void test('seller status refuses flags of other commands', () =>
  withHome(async (home) => {
    for (const args of [
      ['--force'],
      ['--dry-run'],
      ['--config', 'x'],
      ['--publish'],
      ['extra'],
    ]) {
      const result = await status(home, system(home), args);
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, /^Usage:/, args.join(' '));
    }
  }));
