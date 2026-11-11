// Exercises the real buyer HTTP and seller startup lifecycles; all money and inference remain synthetic.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { PAID_BUYER_CODES } from '@gyblos/buyer/constants';
import { HTTP_STATUS } from '@gyblos/config';
import {
  BUYER_BUSY_POLICIES,
  BUYER_ROUTING_CODES,
} from '@gyblos/core/constants';
import { chargeV2 } from '@gyblos/core/pricing-v2';
import { ACCEPTANCE } from '@gyblos/lab-harness/acceptance/constants';

import {
  HTTP_MULTI,
  HTTP_MULTI_CASES,
  HTTP_MULTI_METHODS,
  type HttpMultiCase,
  type HttpMultiReport,
} from './http-multiseller-constants';
import {
  httpMultisellerHost,
  type HttpMultisellerHost,
} from './http-multiseller-host';
import {
  httpMultiAnswer,
  httpMultiChat,
  httpMultiError,
  httpMultiHttpObservation,
  httpMultiText,
} from './http-multiseller-http';
import { httpMultiPhase } from './http-multiseller-phase';
import { PAID_ACCEPTANCE } from './paid-acceptance-constants';
import { paidWait } from './paid-acceptance-host';

function cost(host: HttpMultisellerHost, seller: number) {
  const price = host.catalogPrices.get(host.sellers[seller]!.role.nodeId)!;
  return chargeV2(
    {
      input: PAID_ACCEPTANCE.inputTokens,
      output: [...httpMultiText(seller)].length,
    },
    {
      inputAtomicPerMtok: price.inputAtomicPerMtok,
      outputAtomicPerMtok: price.outputAtomicPerMtok,
    },
  );
}

async function generated(
  host: HttpMultisellerHost,
  seller: number,
  count: number,
) {
  await paidWait(
    async () => (await host.sellers[seller]!.health()).generations === count,
    host.signal,
  );
}
async function parallel(host: HttpMultisellerHost) {
  const [a, b] = host.sellers;
  host.index.available(false);
  assert.ok(
    (await httpMultiChat(host)).response.status >= HTTP_STATUS.badRequest,
  );
  assert.equal((await a!.health()).generations, 0);
  assert.equal(host.ledger.calls.length, 0);
  host.index.available(true);
  await a!.call(HTTP_MULTI_METHODS.HOLD);
  await b!.call(HTTP_MULTI_METHODS.HOLD);
  const beforeDiscovery = host.index.counts().reads;
  const first = httpMultiChat(host);
  await httpMultiPhase(generated(host, 0, 1), first, host.signal);
  assert.ok(
    host.index.counts().reads > beforeDiscovery,
    'The buyer must use discovery after startup',
  );
  const second = httpMultiChat(host);
  await generated(host, 1, 1);
  assert.equal(
    (await httpMultiChat(host)).response.status,
    HTTP_STATUS.tooManyRequests,
  );
  assert.equal((await host.inspect()).length, 2);
  await b!.call(HTTP_MULTI_METHODS.RELEASE);
  httpMultiAnswer(await second, 1);
  await a!.call(HTTP_MULTI_METHODS.RELEASE);
  httpMultiAnswer(await first, 0);
  const entries = await host.inspect();
  const original = entries.find(
    (entry) => entry.terms.sellerNodeId === a!.role.nodeId,
  )!.stored!.snapshot.channelId;
  await host.restart();
  await delay(ACCEPTANCE.controlRefillMs);
  httpMultiAnswer(await httpMultiChat(host), 0);
  const reopened = await host.inspect();
  assert.equal(
    reopened.find((entry) => entry.terms.sellerNodeId === a!.role.nodeId)!
      .stored!.snapshot.channelId,
    original,
  );
  assert.equal(
    host.ledger.calls.filter((call) => call.type === 'deposit').length,
    2,
  );
  const settlement = await host.buyer().chat.session?.settle?.();
  assert.ok(settlement);
  const chargeA = cost(host, 0);
  const chargeB = cost(host, 1);
  assert.equal(settlement.chargedAtomic, String(chargeA * 2n + chargeB));
  assert.equal(
    BigInt(settlement.chargedAtomic) + BigInt(settlement.refundedAtomic),
    BigInt(HTTP_MULTI.totalAtomic),
  );
  assert.equal(
    host.ledger.calls.filter((call) => call.type === 'refund').length,
    2,
  );
  assert.equal(host.ledger.settled.size, 2);
  return 3;
}
async function queue(host: HttpMultisellerHost) {
  const a = host.sellers[0]!;
  await a.call(HTTP_MULTI_METHODS.HOLD);
  const beforeDiscovery = host.index.counts().reads;
  const first = httpMultiChat(host);
  await httpMultiPhase(generated(host, 0, 1), first, host.signal);
  assert.ok(
    host.index.counts().reads > beforeDiscovery,
    'The buyer must use discovery after startup',
  );
  const expired = await httpMultiChat(host);
  httpMultiError(expired, BUYER_ROUTING_CODES.QUEUE_TIMEOUT);
  assert.equal((await host.inspect()).length, 1);
  assert.equal(host.ledger.calls.length, 1);
  const abort = new AbortController();
  const disconnected = httpMultiHttpObservation(host, 'cancelled-waiter');
  const next = httpMultiHttpObservation(host, 'fresh-waiter');
  try {
    const cancelled = httpMultiChat(host, abort.signal, 'cancelled-waiter');
    const rejected = assert.rejects(cancelled);
    await httpMultiPhase(disconnected.bodyRead, cancelled, host.signal);
    abort.abort();
    await rejected;
    await httpMultiPhase(
      disconnected.closed,
      new Promise(() => {}),
      host.signal,
    );
    // Release before the cancelled wait can expire; a missing HTTP cancel now causes an orphan execution.
    const second = httpMultiChat(host, host.signal, 'fresh-waiter');
    await httpMultiPhase(next.bodyRead, second, host.signal);
    await a.call(HTTP_MULTI_METHODS.RELEASE);
    httpMultiAnswer(await first, 0);
    httpMultiAnswer(await second, 0);
  } finally {
    disconnected.dispose();
    next.dispose();
  }
  assert.equal((await a.health()).generations, 2);
  assert.equal((await host.sellers[1]!.health()).generations, 0);
  assert.equal(host.ledger.calls.length, 1);
  assert.equal(host.wire.quotes.get(a.role.nodeId)?.size, 2);
  assert.equal(
    (await host.inspect())[0]!.stored!.snapshot.cumulativeAtomic,
    String(2n * cost(host, 0)),
  );
  return 2;
}
async function uncertain(host: HttpMultisellerHost, sent: boolean) {
  const [a, b] = host.sellers;
  await a!.call(HTTP_MULTI_METHODS.HOLD);
  await a!.call(HTTP_MULTI_METHODS.ACK, true);
  if (sent) await b!.call(HTTP_MULTI_METHODS.HOLD);
  else host.wire.pause(b!.role.nodeId);
  const beforeDiscovery = host.index.counts().reads;
  const first = httpMultiChat(host);
  await httpMultiPhase(generated(host, 0, 1), first, host.signal);
  assert.ok(
    host.index.counts().reads > beforeDiscovery,
    'The buyer must use discovery after startup',
  );
  const second = httpMultiChat(host);
  if (sent) await generated(host, 1, 1);
  else await httpMultiPhase(host.wire.paused, second, host.signal);
  await a!.call(HTTP_MULTI_METHODS.RELEASE);
  const failed = await first;
  assert.ok(failed.response.status >= HTTP_STATUS.badRequest);
  host.wire.resume();
  if (sent) {
    await b!.call(HTTP_MULTI_METHODS.RELEASE);
    httpMultiAnswer(await second, 1);
  } else {
    const refused = await second;
    assert.ok(refused.response.status >= HTTP_STATUS.badRequest);
  }
  httpMultiError(await httpMultiChat(host), PAID_BUYER_CODES.UNRESOLVED);
  assert.equal((await a!.health()).generations, 1);
  assert.equal((await b!.health()).generations, sent ? 1 : 0);
  assert.equal(host.wire.executions.get(b!.role.nodeId) ?? 0, sent ? 1 : 0);
  await host.restart();
  httpMultiError(await httpMultiChat(host), PAID_BUYER_CODES.UNRESOLVED);
  assert.equal((await a!.health()).generations, 1);
  assert.equal((await b!.health()).generations, sent ? 1 : 0);
  return sent ? 1 : 0;
}
async function budget(host: HttpMultisellerHost) {
  const a = host.sellers[0]!;
  await a.call(HTTP_MULTI_METHODS.HOLD);
  const beforeDiscovery = host.index.counts().reads;
  const first = httpMultiChat(host);
  await httpMultiPhase(generated(host, 0, 1), first, host.signal);
  assert.ok(
    host.index.counts().reads > beforeDiscovery,
    'The buyer must use discovery after startup',
  );
  const second = await httpMultiChat(host);
  assert.ok(second.response.status >= HTTP_STATUS.badRequest);
  assert.equal(host.ledger.calls.length, 1);
  assert.equal((await host.inspect()).length, 1);
  assert.equal((await host.sellers[1]!.health()).generations, 0);
  await a.call(HTTP_MULTI_METHODS.RELEASE);
  httpMultiAnswer(await first, 0);
  return 1;
}
export async function httpMultisellerScenario(
  kind: HttpMultiCase,
): Promise<HttpMultiReport> {
  const host = await httpMultisellerHost(
    kind === HTTP_MULTI_CASES.WAIT
      ? BUYER_BUSY_POLICIES.WAIT
      : BUYER_BUSY_POLICIES.REROUTE,
    kind === HTTP_MULTI_CASES.BUDGET
      ? HTTP_MULTI.depositAtomic
      : HTTP_MULTI.totalAtomic,
  );
  try {
    const answers =
      kind === HTTP_MULTI_CASES.PARALLEL
        ? await parallel(host)
        : kind === HTTP_MULTI_CASES.WAIT
          ? await queue(host)
          : kind === HTTP_MULTI_CASES.BUDGET
            ? await budget(host)
            : await uncertain(host, kind === HTTP_MULTI_CASES.SENT);
    const generations = (
      await Promise.all(host.sellers.map((seller) => seller.health()))
    ).reduce((sum, item) => sum + item.generations, 0);
    assert.ok(host.index.counts().reads > 0 && host.index.counts().writes >= 4);
    assert.ok(host.registry.counts().reads >= 2);
    return {
      nativeIroh: true,
      answers,
      generations,
      deposits: host.ledger.calls.filter((call) => call.type === 'deposit')
        .length,
      externalCalls: host.external(),
      registryReads: host.registry.counts().reads,
      forbiddenRpcMethods: host.registry.counts().forbidden,
    };
  } finally {
    await host.close();
  }
}
