// The new session ALPN is advertised only when its host explicitly enables it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import { CONTROL_ALPN } from '@gyblos/protocol/constants';

import { NATIVE_CAPABILITY } from './support/native-runtime';
import { endpointProbe } from './support/relay-fixture';

void test(
  'reusable sessions are advertised only when explicitly enabled',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  () => {
    const token = 'synthetic-session-relay-token-only-for-tests';
    const enabled = endpointProbe({
      GYBLOS_RELAY_TOKEN: token,
      PROBE_BATCH_SESSIONS: '1',
      PROBE_HTTP: '0',
    });
    assert.equal(enabled.error, undefined);
    assert.deepEqual(enabled.alpns, [BATCH_CHANNEL.alpn]);
    const disabled = endpointProbe({
      GYBLOS_RELAY_TOKEN: token,
      PROBE_CONTROL: '1',
      PROBE_HTTP: '0',
    });
    assert.equal(disabled.error, undefined);
    assert.deepEqual(disabled.alpns, [CONTROL_ALPN]);
  },
);
