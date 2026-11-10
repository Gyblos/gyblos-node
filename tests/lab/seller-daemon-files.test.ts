// Owns what the real seller daemon (createNode with its telemetry file on) leaves in its home after one free
// sale over native loopback, on every platform; CI's windows job runs it on Windows, where no service or
// installer test starts the daemon: status.json says ready with the offer listed, the telemetry log holds
// the sale, and the public sequence is written. A telemetry log that cannot open fails silently at run
// time (the sale still succeeds), so only its records show it works.
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { ROLE_FILES, rolePathIn } from '@gyblos/config';
import { SELLER_DAEMON_STATES } from '@gyblos/node/constants';
import { OFFER_PRICING_KINDS, P2P_ROLES } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { sessionProductHost } from '../support/session-product-host';

const sellerFile = (name: string) =>
  rolePathIn(process.env, P2P_ROLES.SELLER, name);

// The log's records, once some have reached a file (they are written in the background).
async function telemetryRecords() {
  const directory = sellerFile(ROLE_FILES.telemetry);
  for (let attempt = 0; attempt < 100; attempt++) {
    const names = await readdir(directory).catch(() => []);
    const text = (
      await Promise.all(
        names.map((name) => readFile(join(directory, name), 'utf8')),
      )
    ).join('');
    if (text.trim()) return text.trim().split('\n');
    await delay(50);
  }
  return [];
}

void test(
  'a free sale through the real daemon leaves its status, telemetry and public sequence',
  { skip: NATIVE_CAPABILITY.transportSkip, timeout: 120_000 },
  async (t) => {
    const host = await sessionProductHost(OFFER_PRICING_KINDS.FREE);
    t.after(host.close);
    let questions = 0;
    await chatSession({
      ...host.buyer().chat,
      read: async () => (++questions === 1 ? 'synthetic' : '/exit'),
      write() {},
    });
    assert.equal(host.engine.attempts(), 1);

    const status = JSON.parse(
      await readFile(sellerFile(ROLE_FILES.status), 'utf8'),
    ) as { status: string };
    assert.equal(status.status, SELLER_DAEMON_STATES.READY);
    const records = await telemetryRecords();
    assert.ok(records.length > 0, 'the telemetry log holds no record');
    for (const record of records) JSON.parse(record);
    assert.ok((await stat(sellerFile(ROLE_FILES.publicSequence))).size > 0);
  },
);
