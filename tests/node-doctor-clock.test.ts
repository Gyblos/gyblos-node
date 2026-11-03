// `gyblos doctor --online` compares this clock with the discovery index's Date header: a clock over the
// warning threshold is reported before buyers refuse its records, the index is asked at its origin only,
// and offline nothing is requested. Synthetic homes and a fake index with its own clock; no network.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { clockOffsetMs } from '@gyblos/node/clock-check';

import {
  doctor,
  freeToml,
  line,
  scenario,
  withOllama,
  type Fixture,
} from './support/doctor-fixture';
import { FAKE_SECRET } from './support/node-config-fixtures';

const DATE = 'Tue, 03 Nov 2026 18:00:00 GMT';
const SERVER = Date.parse(DATE);
const INDEX = 'https://discovery.example.com';

void test('the offset is only what the one-second header and the round trip cannot explain', () => {
  assert.equal(clockOffsetMs(SERVER + 200, SERVER + 400, DATE), 0);
  // 230 ms behind, as measured between two real machines.
  assert.equal(clockOffsetMs(SERVER - 230, SERVER - 200, DATE), -200);
  assert.equal(clockOffsetMs(SERVER + 3500, SERVER + 3600, DATE), 2500);
  // A slow answer could hide seconds of offset, so it proves nothing.
  assert.equal(clockOffsetMs(SERVER, SERVER + 1001, DATE), undefined);
  assert.equal(clockOffsetMs(SERVER, SERVER + 1000, DATE), 0);
  assert.equal(clockOffsetMs(SERVER, SERVER + 1, null), undefined);
  assert.equal(clockOffsetMs(SERVER, SERVER + 1, 'not a date'), undefined);
});

// The index answers with its own clock: `ahead` ms ahead of this machine's, or with no Date header.
function index(ahead: number | null) {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(INDEX)) return globalThis.fetch(input, init);
    requests.push(url);
    return new Response('{}', {
      status: 404,
      headers:
        ahead === null
          ? {}
          : { date: new Date(Date.now() + ahead).toUTCString() },
    });
  };
  return { fetch, requests };
}

async function published(run: Fixture) {
  await withOllama(run);
  await writeFile(
    join(run.root, 'gyblos.toml'),
    `${freeToml(run)}[discovery]\npublish = true\nurl = "${INDEX}/v1/${FAKE_SECRET}"\n`,
  );
}

void test('doctor --online warns when this clock is seconds off the index', () =>
  scenario({}, async (run) => {
    await published(run);
    // This clock is 3.5 s ahead of the index's.
    const fake = index(-3500);
    const result = await doctor(run, ['--online'], {}, { fetch: fake.fetch });
    assert.equal(result.code, 0, result.output);
    assert.match(
      line(result.output, 'clock'),
      /WARN\s+clock\s+CLOCK_SKEWED\s+.*time sync/,
    );
    assert.deepEqual(fake.requests, [INDEX]);
    assert.ok(!result.output.includes(FAKE_SECRET));
  }));

void test('doctor --online accepts a clock within the warning threshold', () =>
  scenario({}, async (run) => {
    await published(run);
    const result = await doctor(
      run,
      ['--online'],
      {},
      { fetch: index(230).fetch },
    );
    assert.equal(result.code, 0, result.output);
    assert.match(line(result.output, 'clock'), /^\s*OK\s+clock/);
  }));

void test('doctor --online reports an index without a Date header as unchecked', () =>
  scenario({}, async (run) => {
    await published(run);
    const result = await doctor(
      run,
      ['--online'],
      {},
      { fetch: index(null).fetch },
    );
    assert.equal(result.code, 0, result.output);
    assert.match(
      line(result.output, 'clock'),
      /WARN\s+clock\s+CLOCK_UNCHECKED/,
    );
  }));

void test('doctor offline never asks the index for its time', () =>
  scenario({}, async (run) => {
    await published(run);
    const fake = index(-9000);
    const result = await doctor(run, [], {}, { fetch: fake.fetch });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(fake.requests, []);
    assert.ok(!/\bclock\b/.test(result.output));
  }));
