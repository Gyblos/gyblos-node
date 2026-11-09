// Chat startup reports only sanitized shared diagnostics; synthetic failures never open a buyer.
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { main } from '@gyblos/buyer/chat-cli';
import { FREE_BUYER_STARTUP } from '@gyblos/buyer/constants';
import { FreeBuyerStartupError } from '@gyblos/buyer/free-startup';
import { RELAY_CONFIGURATION_CODES } from '@gyblos/transport-iroh/constants';
import { RelayConfigurationError } from '@gyblos/transport-iroh/relays';

for (const [name, error, hint] of [
  [
    'missing relay token',
    new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.MISSING_TOKEN,
      'private-token-must-not-leak',
    ),
    /GYBLOS_RELAY_TOKEN/,
  ],
  [
    'missing selection',
    new FreeBuyerStartupError(FREE_BUYER_STARTUP.SELECTION_MISSING),
    /selection\.json/,
  ],
  [
    'unknown failure',
    new Error('private-token-must-not-leak'),
    /unexpected startup failure/,
  ],
] as const) {
  void test(`chat explains ${name} without echoing arbitrary errors`, async (context) => {
    const previous = process.exitCode;
    const messages: string[] = [];
    context.mock.method(console, 'error', (text: string) => {
      messages.push(text);
    });
    try {
      await main({
        start: async () => {
          throw error;
        },
        input: Readable.from([]),
        output: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      });
      assert.equal(process.exitCode, 1);
      assert.equal(messages.length, 1);
      assert.match(messages[0]!, hint);
      assert.doesNotMatch(messages[0]!, /private-token-must-not-leak/);
    } finally {
      process.exitCode = previous;
    }
  });
}
