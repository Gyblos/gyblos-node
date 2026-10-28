// Free admission split for several offers: one seller-wide replay ledger (single use, concurrency) and one
// token budget per offer (daily and per-buyer caps, distinct buyers). Pure; synthetic parsed requests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FREE_EXECUTION_ADMISSION } from '@gyblos/core/constants';
import {
  FreeExecutionAdmission,
  FreeReplayLedger,
} from '@gyblos/core/free-admission';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import { parseFreeExecutionRequest } from '@gyblos/protocol/free-execution';

async function fixture() {
  const vector: { request: unknown } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/free-execution-v3.json'),
      ),
      'utf8',
    ),
  );
  const source = parseFreeExecutionRequest(vector.request);
  const now = FREE_EXECUTION_ADMISSION.utcDayMs - 10;
  const request = (id = 1, peer = source.quote.offer.buyerNodeId) => ({
    ...source,
    requestId: id.toString(16).padStart(32, '0'),
    input: { ...source.input, maxTokens: 10 },
    quote: {
      ...source.quote,
      offer: {
        ...source.quote.offer,
        buyerNodeId: peer,
        requestId: id.toString(16).padStart(32, '0'),
        issuedAt: now,
        expiresAt: now + 1000,
      },
    },
  });
  return { now, request };
}

async function twoOffers(caps = { dailyTokenCap: 14, perBuyerCap: 14 }) {
  const { now, request } = await fixture();
  const ledger = new FreeReplayLedger(now - 1);
  const a = new FreeExecutionAdmission(caps, now - 1, 1024, ledger);
  const b = new FreeExecutionAdmission(caps, now - 1, 1024, ledger);
  return { now, request, a, b };
}

void test('one request id is single use across every offer of the seller', async () => {
  const { now, request, a, b } = await twoOffers();
  a.enter(request(7), 4, now).complete(4);
  assert.throws(() => b.enter(request(7), 4, now), {
    code: FREE_EXECUTION_CODES.REPLAY,
  });
});

void test('one generation at a time across the seller, whichever offer holds it', async () => {
  const { now, request, a, b } = await twoOffers();
  const held = a.enter(request(1), 4, now);
  assert.throws(() => b.enter(request(2), 4, now), {
    code: FREE_EXECUTION_CODES.BUSY,
  });
  held.complete(4);
  b.enter(request(3), 4, now).complete(4);
});

void test('each offer keeps its own daily and per-buyer token caps', async () => {
  const { now, request, a, b } = await twoOffers();
  a.enter(request(1), 4, now).complete();
  assert.throws(() => a.enter(request(2), 4, now), {
    code: FREE_EXECUTION_CODES.DAILY_CAP,
  });
  // Offer A's spent budget does not touch offer B.
  b.enter(request(3), 4, now).complete();
});

void test('a refused cap still spends the request id on the shared ledger, as before', async () => {
  const { now, request, a, b } = await twoOffers({
    dailyTokenCap: 5,
    perBuyerCap: 5,
  });
  assert.throws(() => a.enter(request(1), 4, now), {
    code: FREE_EXECUTION_CODES.DAILY_CAP,
  });
  assert.throws(() => b.enter(request(1), 4, now), {
    code: FREE_EXECUTION_CODES.REPLAY,
  });
});
