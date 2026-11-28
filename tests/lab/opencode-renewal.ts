import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

import { FREE_BUYER, PAID_BUYER } from '@gyblos/buyer/constants';
import { batchSessionPathsIn } from '@gyblos/config';
import { bounded } from '@gyblos/node/buyer-operation';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { sessionApproval } from '@gyblos/node/session-accounting';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import { BUYER_API, parseBuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import { ENGINE_DONE_REASONS, P2P_ROLES } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';

import { blockTestMeter } from '../support/batch-block-product';
import { batchDeferred } from '../support/batch-deferred';
import { HTTP_MULTI } from '../support/http-multiseller-constants';
import { httpMultiHttpObservation } from '../support/http-multiseller-http';
import { isolatedOpenCode } from '../support/opencode-runner';
import { PAID_ACCEPTANCE } from '../support/paid-acceptance-constants';
import { buyerClient } from '../support/session-product-client';
import { sessionProductHost } from '../support/session-product-host';

const depositAtomic = '10200';
const limitAtomic = '30000';
const answer = 'Synthetic answer.';
const fetchRequest = globalThis.fetch;
const racePrompts = [
  'Renewal client alpha',
  'Renewal client bravo',
  'Renewal client charlie',
];
const readChannel = (role: typeof P2P_ROLES.BUYER | typeof P2P_ROLES.SELLER) =>
  inspectBatchSession(batchSessionPathsIn(process.env, role));

function fields(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

async function directTurn(
  url: string,
  model: string,
  key: string,
  prompt: string,
  signal: AbortSignal,
) {
  const started = performance.now();
  const response = await fetchRequest(url, {
    method: 'POST',
    signal,
    headers: {
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      [HTTP_MULTI.traceHeader]: prompt,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  });
  if (!response.ok) {
    const code = fields(fields(await response.json()).error).code;
    assert.fail(
      'Synthetic fetch refused with HTTP ' +
        response.status +
        ' ' +
        (typeof code === 'string' && /^[A-Z_]{1,60}$/.test(code)
          ? code
          : 'UNKNOWN'),
    );
  }
  assert.ok(response.body);
  let firstTextMs: number | undefined;
  let text = '';
  let approved = false;
  let ended = false;
  for await (const line of createInterface({
    input: Readable.from(response.body),
  })) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === FREE_BUYER.streamDone) {
      ended = true;
      continue;
    }
    const chunk = fields(JSON.parse(data));
    assert.ok(Array.isArray(chunk.choices));
    const content = fields(fields(chunk.choices[0]).delta).content;
    if (typeof content === 'string' && content) {
      firstTextMs ??= Math.round(performance.now() - started);
      text += content;
    }
    const payment = chunk[PAID_BUYER.paymentField];
    if (payment) {
      const row = fields(payment);
      assert.equal(row.verdict, SESSION_VERDICTS.APPROVED);
      assert.ok(BigInt(sessionApproval(row.session).approvedAtomic) > 0n);
      approved = true;
    }
  }
  assert.equal(text, answer);
  assert.ok(firstTextMs !== undefined && approved && ended);
  return firstTextMs;
}

async function scenario(mode: 'opencode' | 'fetch' | 'mixed') {
  const opening = batchDeferred<void>();
  const release = batchDeferred<void>();
  const signal = AbortSignal.timeout(180000);
  const dispatches: { question: string; deposit: number; at: number }[] = [];
  let deposits = 0;
  let started = 0;
  let openingAt = 0;
  const host = await sessionProductHost(
    undefined,
    undefined,
    {
      meter: { ...blockTestMeter, output: blockTestMeter.count },
      observe: () => {},
      generate: async (input) => {
        const user =
          input.prompt ??
          input.messages?.filter((message) => message.role === 'user').at(-1)
            ?.content ??
          '';
        dispatches.push({
          question:
            racePrompts.find((prompt) => user.includes(prompt)) ?? 'warmup',
          deposit: deposits,
          at: performance.now(),
        });
        await input.onText?.(answer);
        return {
          text: answer,
          finishReason: ENGINE_DONE_REASONS.STOP,
          usage: {
            inputTokens: 2,
            outputTokens: answer.length,
            totalDurationNs: 0,
            loadDurationNs: 0,
            inputDurationNs: 0,
            outputDurationNs: 0,
          },
        };
      },
    },
    undefined,
    {
      depositAtomic,
      renewalBudgetAtomic: limitAtomic,
      beforeDeposit: async () => {
        if (++deposits === 2) {
          openingAt = performance.now();
          opening.resolve();
          await bounded(release.promise, signal);
        }
      },
    },
  );
  let cli: Awaited<ReturnType<typeof isolatedOpenCode>> | undefined;
  const active: Promise<number>[] = [];
  const observations: ReturnType<typeof httpMultiHttpObservation>[] = [];
  try {
    const client = await buyerClient(host, fetchRequest, limitAtomic);
    const endpoint = host.buyer().url;
    const policy = parseBuyerApiPolicy(
      await (
        await client.owner(new URL(BUYER_API.STATUS_PATH, endpoint))
      ).json(),
    );
    if (mode !== 'fetch')
      cli = await isolatedOpenCode(endpoint, policy.model, client.delegated);
    const direct = (prompt: string) =>
      directTurn(endpoint, policy.model, client.delegated, prompt, signal);
    const primary = (prompt: string) =>
      cli ? cli.ask(prompt, answer) : direct(prompt);
    const coldMs = await primary('Open the original channel.');
    const warmMs = await primary('Measure the warm channel.');
    let warm = await readChannel(P2P_ROLES.BUYER);
    assert.ok(warm?.snapshot.channelId);
    const original = warm.snapshot.channelId;
    for (
      let i = 0;
      BigInt(warm.terms.depositAtomic) -
        BigInt(warm.snapshot.cumulativeAtomic) >=
      BigInt(PAID_ACCEPTANCE.maxAtomic);
      i++
    ) {
      assert.ok(i < 16, 'Expected normal usage to exhaust quote headroom');
      await direct('Consume existing escrow ' + i);
      warm = await readChannel(P2P_ROLES.BUYER);
      assert.equal(warm?.snapshot.channelId, original);
      assert.ok(warm);
    }
    assert.equal(deposits, 1);
    console.log(
      'Existing escrow below quote',
      mode,
      warm.snapshot.cumulativeAtomic,
    );
    const baseline = dispatches.length;
    const approvals = host.finance.approvals();
    started = performance.now();
    const first = primary(racePrompts[0]!);
    active.push(first);
    await Promise.race([
      bounded(opening.promise, signal),
      first.then(() =>
        assert.fail('Turn completed before the replacement opened'),
      ),
    ]);
    if (mode === 'mixed') {
      for (const prompt of racePrompts.slice(1)) {
        observations.push(httpMultiHttpObservation(host, prompt));
        active.push(direct(prompt));
      }
      await Promise.race([
        bounded(Promise.all(observations.map((item) => item.arrived)), signal),
        ...active
          .slice(1)
          .map((p) =>
            p.then(() =>
              assert.fail('Turn completed before the replacement was released'),
            ),
          ),
      ]);
    }
    const releasedAt = performance.now();
    release.resolve();
    const firstTextMs = await Promise.all(active);
    const current = await readChannel(P2P_ROLES.BUYER);
    assert.ok(current?.snapshot.channelId);
    assert.notEqual(current.snapshot.channelId, original);
    const expected = mode === 'mixed' ? racePrompts : racePrompts.slice(0, 1);
    const renewed = dispatches.slice(baseline);
    assert.deepEqual(
      renewed.map((item) => item.question).sort(),
      [...expected].sort(),
    );
    assert.ok(renewed.every((item) => item.deposit === 2));
    assert.equal(host.finance.approvals() - approvals, expected.length);
    assert.equal(deposits, 2);
    assert.equal(
      host.finance.calls.filter((call) => call === 'deposit').length,
      2,
    );
    const prior = host.finance.settled.get(original);
    assert.ok(prior);
    assert.equal(prior.chargedAtomic, warm.snapshot.cumulativeAtomic);
    assert.equal(
      BigInt(prior.refundedAtomic) + BigInt(prior.chargedAtomic),
      BigInt(depositAtomic),
    );
    assert.ok(
      BigInt(prior.chargedAtomic) + BigInt(current.terms.depositAtomic) <=
        BigInt(limitAtomic),
    );
    const { snapshot } = parseBuyerApiKeysReply(
      await (await client.owner(new URL(BUYER_API_KEYS.PATH, endpoint))).json(),
    );
    assert.equal(snapshot.blocked, false);
    assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
    assert.equal(
      snapshot.keys[0]?.spentAtomic,
      String(
        BigInt(prior.chargedAtomic) + BigInt(current.snapshot.cumulativeAtomic),
      ),
    );
    console.log(
      JSON.stringify({
        mode,
        version: cli?.version,
        coldFirstTextMs: coldMs,
        warmFirstTextMs: warmMs,
        heldOpeningMs: Math.round(releasedAt - openingAt),
        firstDispatchMs: Math.round(renewed[0]!.at - started),
        openingStartedMs: Math.round(openingAt - started),
        firstTextMs,
        completeMs: Math.round(performance.now() - started),
        deposits,
        paidDispatches: renewed.length,
      }),
    );
  } finally {
    release.resolve();
    await Promise.allSettled(active);
    for (const item of observations) item.dispose();
    try {
      await cli?.close();
    } finally {
      await host.close();
    }
  }
}

if (isMain(import.meta.url)) {
  await scenario('fetch');
  if (!process.argv.includes('--fetch-only')) {
    await scenario('opencode');
    await scenario('mixed');
  }
}
