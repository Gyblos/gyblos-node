import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '@gyblos/node-app/cli';
import { verifyProfileClaim } from '@gyblos/protocol/profile-claim';

import type { Home } from './support/status-fixture';
import { json, withKeyedHome } from './support/verify-github-fixture';

const INDEX = 'https://discovery.gyblos.com/v1/profile';

async function nameRun(
  home: Home,
  args: string[],
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
  env: Record<string, string> = {},
) {
  const requests: { url: string; init: RequestInit }[] = [];
  let stdout = '';
  let stderr = '';
  const code = await runCli(['seller', 'name', ...args], {
    env: { GYBLOS_HOME: home.home, ...env },
    cwd: home.root,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return answer(url, init);
    },
  });
  assert.equal((stdout + stderr).includes(home.home), false);
  const posted = requests
    .filter((request) => request.url === INDEX)
    .map((request) => JSON.parse(String(request.init.body)) as unknown);
  return { code, stdout, stderr, requests, posted };
}

const accept = (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { claim: { name: unknown } };
  return json(200, { ok: true, name: body.claim.name });
};

void test('seller name signs the normalized name, posts it to the index and prints public identifiers only', async () => {
  await withKeyedHome(async (home) => {
    const run = await nameRun(home, ['  Ada   Lovelace '], accept);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.posted.length, 1);
    const signed = await verifyProfileClaim(run.posted[0]);
    assert.equal(signed.claim.nodeId, home.nodeId);
    assert.equal(signed.claim.name, 'Ada Lovelace');
    assert.match(run.stdout, /Ada Lovelace/);
    assert.match(run.stdout, new RegExp(home.nodeId));
    assert.match(run.stdout, /the index at discovery\.gyblos\.com/);
    assert.doesNotMatch(run.stdout, /hidden/);
    assert.match(run.stdout, /not verified/i);
    assert.equal(run.stdout.includes(signed.signature), false);
  });
});

void test('seller name joins unquoted words into one name', async () => {
  await withKeyedHome(async (home) => {
    const run = await nameRun(home, ['Lab', '42'], accept);
    assert.equal(run.code, 0, run.stderr);
    const signed = await verifyProfileClaim(run.posted[0]);
    assert.equal(signed.claim.name, 'Lab 42');
  });
});

void test('seller name --clear signs a null name', async () => {
  await withKeyedHome(async (home) => {
    const run = await nameRun(home, ['--clear'], accept);
    assert.equal(run.code, 0, run.stderr);
    const signed = await verifyProfileClaim(run.posted[0]);
    assert.equal(signed.claim.name, null);
    assert.match(run.stdout, /cleared/i);
    assert.match(run.stdout, /up to 10 seconds to stop showing it/);
  });
});

void test('seller name refuses invalid and reserved names locally, before reading the key or the index', async () => {
  await withKeyedHome(async (home) => {
    for (const [input, code] of [
      ['Ada ✓', 'NAME_INVALID'],
      ['✅', 'NAME_INVALID'],
      [`Ada${String.fromCodePoint(0x202e)}`, 'NAME_INVALID'],
      ['x'.repeat(33), 'NAME_INVALID'],
      ['GYBLOS team', 'NAME_RESERVED'],
    ] as const) {
      const run = await nameRun(home, [input], () => assert.fail('fetched'));
      assert.equal(run.code, 1);
      assert.match(run.stderr, new RegExp(`\\[${code}\\]`));
      assert.equal(run.requests.length, 0);
    }
  });
});

void test('seller name --status reads the index view, or says there is none', async () => {
  await withKeyedHome(async (home) => {
    const shown = await nameRun(home, ['--status'], (url) => {
      assert.equal(url, `${INDEX}/${home.nodeId}`);
      return json(200, {
        nodeId: home.nodeId,
        name: 'Ada Lovelace',
        issuedAt: 1_800_000_000_000,
        signature: 'ab'.repeat(64),
      });
    });
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /Ada Lovelace/);
    assert.match(shown.stdout, /not verified/i);
    assert.equal(shown.posted.length, 0);
    const none = await nameRun(home, ['--status'], () =>
      json(404, { error: 'NO_PROFILE' }),
    );
    assert.equal(none.code, 0, none.stderr);
    assert.match(none.stdout, /No public name/);
  });
});

void test('seller name explains index refusals with a static code', async () => {
  await withKeyedHome(async (home) => {
    for (const [status, body, code] of [
      [403, { error: 'UNKNOWN_NODE' }, 'DISCOVERY_UNKNOWN_NODE'],
      [409, { error: 'STALE_CLAIM' }, 'DISCOVERY_STALE_CLAIM'],
      [429, {}, 'DISCOVERY_RATE_LIMITED'],
      [503, {}, 'DISCOVERY_UNAVAILABLE'],
      [404, {}, 'DISCOVERY_HTTP_STATUS'],
    ] as const) {
      const run = await nameRun(home, ['Ada'], () => json(status, body));
      assert.equal(run.code, 1);
      assert.match(run.stderr, new RegExp(`\\[${code}\\]\\n$`));
    }
    const offline = await nameRun(home, ['Ada'], () => {
      throw new TypeError('offline');
    });
    assert.equal(offline.code, 1);
    assert.match(offline.stderr, /\[DISCOVERY_NETWORK_FAILED\]/);
  });
});

void test('seller name hints use the container command inside Docker', async () => {
  await withKeyedHome(async (home) => {
    const run = await nameRun(
      home,
      ['Ada'],
      () => json(403, { error: 'UNKNOWN_NODE' }),
      { GYBLOS_CONTAINER: '1' },
    );
    assert.equal(run.code, 1);
    assert.match(
      run.stderr,
      /docker compose exec seller gyblos seller register/,
    );
  });
});

void test('seller name refuses bad usage', async () => {
  await withKeyedHome(async (home) => {
    for (const args of [
      [],
      ['--clear', '--status'],
      ['Ada', '--clear'],
      ['Ada', '--status'],
      ['--nope'],
    ]) {
      const run = await nameRun(home, args, () => assert.fail('fetched'));
      assert.equal(run.code, 1, args.join(' '));
      assert.match(run.stderr, /Usage: gyblos seller name/);
      assert.match(run.stderr, /gyblos seller name -- "-<name>"/);
    }
  });
});

void test('seller name is listed in the CLI help', async () => {
  let stdout = '';
  const code = await runCli(['--help'], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => undefined,
  });
  assert.equal(code, 0);
  assert.match(stdout, /gyblos seller name "<name>" \| --clear \| --status/);
  assert.match(stdout, /-- before a name that starts with -/);
});

const dated = (status: number, body: unknown, offsetMs: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      date: new Date(Date.now() + offsetMs).toUTCString(),
    },
  });

void test('seller name says in plain words which part of a refused name failed', async () => {
  await withKeyedHome(async (home) => {
    for (const [input, code, text] of [
      ['Ada ✓', 'NAME_INVALID', /emoji|symbol/],
      ['\u0301Ada', 'NAME_INVALID', /accent|mark/i],
      ['Ada \u0410da', 'NAME_INVALID', /one writing system/],
      ['x'.repeat(33), 'NAME_INVALID', /1 to 32 characters/],
      ['GYBL0S', 'NAME_RESERVED', /gyblos.*verified/s],
      ['Official seller', 'NAME_RESERVED', /official/],
    ] as const) {
      const run = await nameRun(home, [input], () => assert.fail('fetched'));
      assert.equal(run.code, 1);
      assert.match(run.stderr, text);
      assert.match(run.stderr, new RegExp(`\\[${code}\\]`));
    }
  });
});

void test('seller name suggests a UTF-8 terminal when letters arrived as question marks', async () => {
  await withKeyedHome(async (home) => {
    for (const input of ['Jos? Garc?a', 'Jos\ufffd']) {
      const run = await nameRun(home, [input], () => assert.fail('fetched'));
      assert.equal(run.code, 1);
      assert.match(run.stderr, /UTF-8/);
    }
    const plain = await nameRun(home, ['Ada ✓'], () => assert.fail('fetched'));
    assert.doesNotMatch(plain.stderr, /UTF-8/);
  });
});

void test('seller name explains clock refusals with the gap the index reports', async () => {
  await withKeyedHome(async (home) => {
    const behind = await nameRun(home, ['Ada'], () =>
      dated(409, { error: 'STALE_CLAIM' }, 120_000),
    );
    assert.equal(behind.code, 1);
    assert.match(
      behind.stderr,
      /clock may be behind, or a newer name was already sent/,
    );
    assert.match(behind.stderr, /Turn on automatic time/);
    assert.match(behind.stderr, /1(19|20|21) s behind/);
    assert.match(behind.stderr, /\[DISCOVERY_STALE_CLAIM\]\n$/);
    const ahead = await nameRun(home, ['Ada'], () =>
      dated(400, { error: 'INVALID_CLAIM' }, -60_000),
    );
    assert.equal(ahead.code, 1);
    assert.match(ahead.stderr, /signed time/);
    assert.match(ahead.stderr, /(59|60|61) s ahead/);
    assert.match(ahead.stderr, /\[DISCOVERY_CLAIM_REJECTED\]\n$/);
    const shape = await nameRun(home, ['Ada'], () =>
      dated(400, { error: 'INVALID_CLAIM' }, 0),
    );
    assert.equal(shape.code, 1);
    assert.doesNotMatch(shape.stderr, /clock|time/);
    assert.match(shape.stderr, /\[DISCOVERY_CLAIM_REJECTED\]\n$/);
  });
});

void test('seller name explains an old index and a name held by the operator', async () => {
  await withKeyedHome(async (home) => {
    const old = await nameRun(home, ['Ada'], () => json(404, {}));
    assert.match(old.stderr, /does not take seller names yet/);
    const held = await nameRun(home, ['Ada'], () =>
      json(403, { error: 'PROFILE_HELD' }),
    );
    assert.equal(held.code, 1);
    assert.match(held.stderr, /operator/);
    assert.match(held.stderr, /\[DISCOVERY_PROFILE_HELD\]\n$/);
  });
});

void test('seller name accepts a name that starts with a hyphen after --, and says when it shows', async () => {
  await withKeyedHome(async (home) => {
    const run = await nameRun(home, ['--', '-Ada'], accept);
    assert.equal(run.code, 0, run.stderr);
    const signed = await verifyProfileClaim(run.posted[0]);
    assert.equal(signed.claim.name, '-Ada');
    assert.match(run.stdout, /10 seconds/);
  });
});

void test('seller name prints the verify tip as a container command inside Docker', async () => {
  await withKeyedHome(async (home) => {
    const run = await nameRun(home, ['Ada'], accept, { GYBLOS_CONTAINER: '1' });
    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stdout,
      /docker compose exec seller gyblos seller verify github/,
    );
  });
});

void test('seller name --status says when the index does not take seller names yet', async () => {
  await withKeyedHome(async (home) => {
    const run = await nameRun(home, ['--status'], () =>
      json(404, { error: 'NOT_FOUND' }),
    );
    assert.equal(run.code, 1);
    assert.match(run.stderr, /does not take seller names yet/);
    assert.match(run.stderr, /\[DISCOVERY_HTTP_STATUS\]\n$/);
  });
});

void test('seller name --status says when an operator removed the name', async () => {
  await withKeyedHome(async (home) => {
    const run = await nameRun(home, ['--status'], () =>
      json(403, { error: 'PROFILE_HELD' }),
    );
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /operator removed/);
  });
});

void test('seller name says the clock may be wrong when it is ahead, in minutes or hours for large gaps', async () => {
  await withKeyedHome(async (home) => {
    const ahead = await nameRun(home, ['Ada'], () =>
      dated(409, { error: 'STALE_CLAIM' }, -600_000),
    );
    assert.match(ahead.stderr, /clock may be wrong/);
    assert.match(ahead.stderr, /10 min ahead/);
    const hours = await nameRun(home, ['Ada'], () =>
      dated(409, { error: 'STALE_CLAIM' }, 3 * 3_600_000),
    );
    assert.match(hours.stderr, /clock may be behind/);
    assert.match(hours.stderr, /3 h behind/);
    const slightly = await nameRun(home, ['Ada'], () =>
      dated(400, { error: 'INVALID_CLAIM' }, -3_500),
    );
    assert.match(slightly.stderr, /signed time/);
  });
});

void test('seller name suggests a straight apostrophe for other quote marks', async () => {
  await withKeyedHome(async (home) => {
    const run = await nameRun(home, ['O\u2018Brien'], () =>
      assert.fail('fetched'),
    );
    assert.equal(run.code, 1);
    assert.match(run.stderr, /straight apostrophe '/);
  });
});
