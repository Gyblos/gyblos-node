// A seller older than tool calling (v0.1.0-beta.9) refuses a quote that asks for tools as an invalid
// request. That is "no tools", not a fault: it is reported as one and does not cool the seller down, so
// one request from a coding agent (which always sends tools) does not take every such seller out of
// service for requests without tools. Without tools, an invalid refusal still cools down. Loopback
// control seller; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';

import { selectionFixture } from './support/buyer-selection';

type SellerFailure = { code: string };

for (const tools of [true, false])
  void test(`an invalid-request quote refusal ${tools ? 'with tools is "no tools"' : 'without tools still cools down'}`, async (t) => {
    const run = await selectionFixture();
    t.after(() => run.wire.close());
    run.client.requestOffer = async () => {
      throw new ControlError(CONTROL_CODES.INVALID);
    };
    const failures: SellerFailure[] = [];
    const stats = new Map();
    const result = await selectVerifiedBuyerQuote(
      {
        ...run.config,
        request: { ...run.config.request, ...(tools ? { tools: true } : {}) },
      },
      {
        ...run.dependencies,
        stats,
        onSellerFailure: (failure) => failures.push(failure),
      },
    );
    assert.equal(result.ok, false);
    const nodeId = run.config.sellers[0]!.nodeId;
    assert.equal(
      failures[0]?.code,
      tools ? CONTROL_CODES.TOOLS : CONTROL_CODES.INVALID,
    );
    assert.equal(
      stats.get(nodeId)?.cooldownUntil == null,
      tools,
      'cooled down only without tools',
    );
  });
