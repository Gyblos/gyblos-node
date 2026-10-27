// A bounded raw engine response can exceed the JSON frame; the seller must return a static error frame.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import {
  encodeFreeExecutionRequest,
  FreeExecutionResponseReader,
} from '@gyblos/protocol/free-execution-framing';
import type { ControlStream } from '@gyblos/transport-iroh/control-io';
import { serveFreeExecutionStream } from '@gyblos/transport-iroh/free-server';

import { freeSellerFixture } from './support/free-seller';

void test('free seller sends an encodable LIMIT error when legal text expands beyond the response frame', async () => {
  const state = await freeSellerFixture();
  state.setText('\0'.repeat(FREE_EXECUTION.outputBytes));
  const request = await state.request();
  const frame = encodeFreeExecutionRequest(request);
  let offset = 0;
  const sent: Uint8Array[] = [];
  let closes = 0;
  let releases = 0;
  const stream: ControlStream = {
    recv: {
      readExact: async (size) => {
        const result = frame.subarray(offset, offset + size);
        offset += size;
        return [...result];
      },
      read: async () => [],
    },
    send: {
      writeAll: async (bytes) => {
        sent.push(Uint8Array.from(bytes));
      },
      finish: async () => {},
    },
  };
  await serveFreeExecutionStream(
    stream,
    state.service,
    request.quote.offer.buyerNodeId,
    () => {
      closes++;
    },
    new AbortController().signal,
    () => () => {
      releases++;
    },
  );
  assert.equal(state.calls(), 1);
  assert.equal(closes, 0);
  assert.equal(releases, 1);
  assert.equal(sent.length, 1);
  const reader = new FreeExecutionResponseReader();
  reader.push(sent[0]!);
  assert.equal(reader.finish().error?.code, FREE_EXECUTION_CODES.LIMIT);
});
