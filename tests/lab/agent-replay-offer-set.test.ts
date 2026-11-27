import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { createAcceptanceClock } from '@gyblos/lab-harness/acceptance/clock';
import { ACCEPTANCE_MODES } from '@gyblos/lab-harness/acceptance/constants';
import { createFreeSeller } from '@gyblos/lab-harness/acceptance/free-session';
import { refreshLikeDaemon } from '@gyblos/lab-harness/acceptance/host';
import { SELLER_PUBLIC_RECORDS } from '@gyblos/node/constants';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import { replayRequest } from '../../lab/tools/agent-replay/client';
import { startReplayNetwork } from '../../lab/tools/agent-replay/network';
import { NATIVE_TEST_OPTIONS } from '../support/native-runtime';

void test('a transient refresh refusal is absorbed and any other failure is rethrown, like the daemon', async () => {
  await refreshLikeDaemon(() =>
    Promise.reject(new ControlError(CONTROL_CODES.STALE)),
  )();
  await assert.rejects(
    refreshLikeDaemon(() =>
      Promise.reject(new ControlError(CONTROL_CODES.INTERNAL)),
    )(),
    ControlError,
  );
  await assert.rejects(
    refreshLikeDaemon(() => Promise.reject(new Error('signing failed')))(),
    /signing failed/,
  );
});

void test(
  'one seller serves two back-to-back agent requests before any renewal',
  NATIVE_TEST_OPTIONS,
  async () => {
    const signal = AbortSignal.timeout(60_000);
    const network = await startReplayNetwork(1, signal);
    try {
      const origin = performance.now();
      for (const tag of ['replay-request-1', 'replay-request-2']) {
        const timing = await replayRequest(
          network.url,
          {
            tag,
            role: 'main',
            turn: 1,
            messages: [
              { role: 'user', content: 'task' },
              { role: 'user', content: tag },
            ],
          },
          origin,
          signal,
        );
        assert.equal(timing.status, 200);
        assert.equal(timing.code, null);
      }
      assert.deepEqual(network.cooldowns, []);
    } finally {
      await network.close();
    }
  },
);

void test(
  'an offer-set seller signs catalogs with the daemon publishing lifetime',
  NATIVE_TEST_OPTIONS,
  async () => {
    const signal = AbortSignal.timeout(60_000);
    const seller = await createFreeSeller(
      signal,
      { clock: createAcceptanceClock(ACCEPTANCE_MODES.OLLAMA, signal) },
      false,
      { offerSet: true },
    );
    try {
      const { record } = seller.host().control.records.current();
      assert.equal(
        record.expiresAt - record.issuedAt,
        SELLER_PUBLIC_RECORDS.catalogMs,
      );
    } finally {
      await seller.close();
    }
  },
);
