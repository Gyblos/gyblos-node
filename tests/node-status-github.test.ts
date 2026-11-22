// The `github` line of `gyblos seller status --online`: the account the index links to this seller and its
// state while it serves, "not linked" without a claim, and "unavailable" when the index cannot answer.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { DISCOVERY_BASE } from './support/discovery-fixture';
import {
  daemonReady,
  status,
  system,
  withHome,
} from './support/status-fixture';

const CLAIMS = `${DISCOVERY_BASE}/identity/github/`;
const PUBLISH = `version = 1\n[node]\nnetwork = "devnet"\n[discovery]\npublish = true\nurl = "${DISCOVERY_BASE}"\n`;

void test('seller status --online shows the GitHub claim the index holds', () =>
  withHome(async (home) => {
    await writeFile(join(home.root, 'config.toml'), PUBLISH);
    await daemonReady(home);
    const answer = (body: unknown, code = 200) =>
      system(home, {
        fetch: async (url) => {
          if (url !== `${CLAIMS}${home.nodeId}`) throw new Error('offline');
          return new Response(JSON.stringify(body), { status: code });
        },
      });
    const view = {
      nodeId: home.nodeId,
      account: 'octo-cat',
      gist: '0123456789abcdef0123456789abcdef',
      state: 'verified',
      reason: null,
      checkedAt: 1,
      verifiedAt: 1,
    };
    const verified = await status(home, answer(view), ['--online']);
    assert.match(
      verified.stdout,
      /^ {2}github {8}octo-cat, verified \(https:\/\/gist\.github\.com\/octo-cat\/0123456789abcdef0123456789abcdef\)$/m,
    );
    const pending = await status(
      home,
      answer({ ...view, state: 'pending', reason: 'NODE_ID_MISSING' }),
      ['--online'],
    );
    assert.match(
      pending.stdout,
      /github {8}octo-cat, pending \(NODE_ID_MISSING\)/,
    );
    const none = await status(home, answer({ error: 'NOT_FOUND' }, 404), [
      '--online',
    ]);
    assert.match(none.stdout, /github {8}not linked/);
    const down = await status(home, system(home), ['--online']);
    assert.match(down.stdout, /github {8}unavailable \(index unreachable\)/);
    const offline = await status(home, answer(view));
    assert.equal(offline.stdout.includes('github'), false);
  }));
