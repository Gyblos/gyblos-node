import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { paidChannelEligibility } from '@gyblos/buyer/channel-eligibility';
import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { batchSessionPathsIn } from '@gyblos/config';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { inspectBatchSession } from '@gyblos/payments-upto/batch-session';
import {
  BUYER_API,
  parseBuyerApiPolicy,
  parsePaidChannelEligibility,
} from '@gyblos/protocol/buyer-api';
import {
  BUYER_API_KEYS,
  parseBuyerApiKeysReply,
} from '@gyblos/protocol/buyer-api-keys';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { blockTestMeter } from '../support/batch-block-product';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import {
  interruptedFragment,
  interruptedGeneration,
} from '../support/opencode-interruption';
import { paidSellerConfiguration } from '../support/paid-acceptance-config';
import { buyerClient } from '../support/session-product-client';
import { sessionProductHost } from '../support/session-product-host';

for (const scenario of ['restart', 'live', 'desktop'])
  void test(
    scenario === 'desktop'
      ? 'an owner explicitly choosing Free can repeat an interrupted paid prompt'
      : scenario === 'restart'
        ? 'restarting a delegated buyer charges exactly the finalized signed prefix after a visible cut'
        : 'a live delegated fetch recovers automatically across a finalized visible cut',
    { skip: NATIVE_CAPABILITY.transportSkip, timeout: 150000 },
    async (t) => {
      const restart = scenario === 'restart';
      const request = globalThis.fetch;
      const cut = new AbortController();
      let sellerStopped: Promise<unknown> | undefined;
      let dispatches = 0;
      const host = await sessionProductHost(
        undefined,
        undefined,
        {
          meter: { ...blockTestMeter, output: blockTestMeter.count },
          contextTokens: 64000,
          maxTokens: 160,
          observe: () => {},
          generate: async (input) => {
            dispatches++;
            if (dispatches > 1) {
              await input.onText?.('done');
              return {
                text: 'done',
                finishReason: ENGINE_DONE_REASONS.STOP,
                usage: {
                  inputTokens: 2,
                  outputTokens: 4,
                  inputDurationNs: 0,
                  outputDurationNs: 0,
                  totalDurationNs: 0,
                  loadDurationNs: 0,
                },
              };
            }
            assert.ok(input.signal);
            sellerStopped = once(input.signal, 'abort', {
              signal: AbortSignal.timeout(8000),
            });
            void sellerStopped.catch(() => undefined);
            return interruptedGeneration(input.onText, input.signal);
          },
        },
        undefined,
        { depositAtomic: '10000', renewalBudgetAtomic: '30000' },
      );
      t.after(async () => {
        cut.abort();
        await host.close();
      });
      const { delegated, owner } = await buyerClient(host, request, '10000');
      const url = host.buyer().url;
      const policy = parseBuyerApiPolicy(
        await (await owner(new URL(BUYER_API.STATUS_PATH, url))).json(),
      );
      const status = async () =>
        parseBuyerApiKeysReply(
          await (
            await owner(new URL(BUYER_API_KEYS.PATH, host.buyer().url))
          ).json(),
        ).snapshot;
      const caller = scenario === 'desktop' ? owner : request;
      const response = await caller(new URL(url), {
        method: 'POST',
        signal: AbortSignal.any([cut.signal, AbortSignal.timeout(30000)]),
        headers: {
          authorization: 'Bearer ' + delegated,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: policy.model,
          messages: [{ role: FREE_CHAT_ROLES.USER, content: 'synthetic' }],
          max_completion_tokens: 128,
          stream: true,
        }),
      });
      if (!response.ok) assert.fail(await response.text());
      assert.ok(response.body);
      let bytes = '';
      const reader = response.body.getReader();
      while (!cut.signal.aborted) {
        const chunk = await reader.read();
        assert.ok(!chunk.done);
        bytes += Buffer.from(chunk.value).toString();
        if (bytes.includes(interruptedFragment.trim())) {
          cut.abort();
          break;
        }
      }
      assert.ok(cut.signal.aborted);
      assert.ok(sellerStopped);
      await sellerStopped;
      if (restart) await host.restartBuyer();
      if (scenario !== 'desktop') assert.equal((await status()).blocked, true);
      const stored = await inspectBatchSession(
        batchSessionPathsIn(process.env, P2P_ROLES.SELLER),
      );
      assert.ok(stored?.snapshot.channelId);
      const { channelId, cumulativeAtomic } = stored.snapshot;
      assert.equal(cumulativeAtomic, '136');
      host.finance.settled.set(channelId, {
        channelId,
        chargedAtomic: cumulativeAtomic,
        refundedAtomic: String(
          BigInt(stored.terms.depositAtomic) - BigInt(cumulativeAtomic),
        ),
        transaction: 'syntheticConfirmedClose',
      });
      async function switchToFree() {
        await paidSellerConfiguration(OFFER_PRICING_KINDS.FREE);
        const configFile = process.env.GYBLOS_CONFIG!;
        await writeFile(
          configFile,
          (await readFile(configFile, 'utf8')).replace(
            'publish = true',
            'publish = false',
          ),
        );
        await host.restartBoth();
      }
      if (scenario === 'desktop') {
        await switchToFree();
        const currentPolicy = parseBuyerApiPolicy(
          await (
            await owner(new URL(BUYER_API.STATUS_PATH, host.buyer().url))
          ).json(),
        );
        const submit = (
          explicit: boolean,
          path:
            | typeof BUYER_API.CHAT_PATH
            | typeof BUYER_API.CHANNEL_CHAT_PATH = BUYER_API.CHANNEL_CHAT_PATH,
        ) =>
          owner(new URL(path, host.buyer().url), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'if-match': JSON.stringify(currentPolicy.policyId),
              ...(explicit && {
                [BUYER_API.EXPLICIT_FREE_HEADER]: OFFER_PRICING_KINDS.FREE,
              }),
            },
            body: JSON.stringify({
              ...(path === BUYER_API.CHANNEL_CHAT_PATH && {
                [BUYER_API.FREE_ONLY_FIELD]: true,
              }),
              model: policy.model,
              messages: [{ role: FREE_CHAT_ROLES.USER, content: 'synthetic' }],
              stream: true,
            }),
          });
        const ordinary = await submit(true, BUYER_API.CHAT_PATH);
        assert.equal(ordinary.ok, false);
        assert.match(
          await ordinary.text(),
          new RegExp(SESSION_CODES.STATUS_UNKNOWN),
        );
        assert.equal(dispatches, 1);
        const automatic = await submit(false);
        assert.match(
          await automatic.text(),
          new RegExp(SESSION_CODES.STATUS_UNKNOWN),
        );
        assert.equal(dispatches, 1);
        const chosen = await submit(true);
        assert.equal(chosen.status, 200, await chosen.clone().text());
        assert.match(await chosen.text(), /done/);
        assert.equal(dispatches, 2);
        assert.deepEqual(host.finance.calls, ['deposit']);
        return;
      }
      if (restart) {
        await host.restartBuyer();
        const after = await status();
        assert.equal(after.blocked, false);
        assert.equal(after.keys[0]?.spentAtomic, '136');
        assert.equal(after.keys[0]?.reservedAtomic, '0');
        assert.equal(host.finance.approvals(), 1);
        assert.deepEqual(host.finance.calls, ['deposit']);
        const eligibility = await paidChannelEligibility(
          process.env,
          {
            payer: stored.terms.buyer,
            network: stored.terms.network,
            mint: stored.terms.mint,
            nodeId: stored.terms.sellerNodeId,
            owner: stored.terms.owner,
            renewalPolicy: {
              depositAtomic: '10000',
              renewalBudgetAtomic: '30000',
            },
          },
          () => stored.terms.expiresAt + 1,
          host.finance.observeChannel,
          AbortSignal.timeout(2000),
        );
        assert.equal(eligibility.blocker, null);
        assert.equal(
          parsePaidChannelEligibility(eligibility).channelId,
          channelId,
        );
      }
      const follow = (content: string, token = delegated) =>
        request(host.buyer().url, {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
          headers: {
            authorization: 'Bearer ' + token,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: policy.model,
            messages: [{ role: FREE_CHAT_ROLES.USER, content }],
            max_completion_tokens: 128,
            stream: true,
          }),
        });
      const afterCooldown = async (question: string, token = delegated) => {
        const initial = await follow(question, token);
        if (
          initial.status === 503 &&
          (await initial.clone().text()).includes(
            SELLER_SELECTION_CODES.NO_CANDIDATES,
          )
        ) {
          await delay(BUYER_SELECTION.cooldownMs + 100);
          return follow(question, token);
        }
        return initial;
      };
      const next = await afterCooldown('new question');
      const nextText = await next.text();
      assert.equal(next.status, 200, nextText);
      assert.match(nextText, /done/);
      assert.equal(dispatches, 2);
      if (!restart) {
        const snapshot = await status();
        assert.equal(snapshot.blocked, false);
        assert.equal(snapshot.keys[0]?.settledAtomic, cumulativeAtomic);
        assert.equal(snapshot.keys[0]?.reservedAtomic, '0');
        assert.equal(
          host.finance.calls.filter((call) => call === 'deposit').length,
          2,
        );
        return;
      }
      await host.restartBuyer();
      const replay = await afterCooldown('synthetic');
      assert.equal(replay.ok, false);
      assert.match(
        await replay.text(),
        new RegExp(SESSION_CODES.STATUS_UNKNOWN),
      );
      assert.equal(dispatches, 2);
      const other = await buyerClient(host, request, '1000');
      const independent = await afterCooldown('synthetic', other.delegated);
      assert.equal(independent.status, 200, await independent.clone().text());
      assert.match(await independent.text(), /done/);
      assert.equal(dispatches, 3);
      await switchToFree();
      const freeReplay = await afterCooldown('synthetic');
      assert.equal(freeReplay.ok, false);
      assert.match(
        await freeReplay.text(),
        new RegExp(SESSION_CODES.STATUS_UNKNOWN),
      );
      assert.equal(dispatches, 3);
      const freeQuestion = await afterCooldown('fresh free question');
      assert.equal(freeQuestion.status, 200, await freeQuestion.clone().text());
      assert.match(await freeQuestion.text(), /done/);
      assert.equal(dispatches, 4);

      assert.equal(
        host.finance.calls.filter((call) => call === 'deposit').length,
        2,
      );
    },
  );
