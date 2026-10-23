// Regresses engine mapping and asynchronous quote validation with synthetic signers only.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptControlQuote,
  createControlQuote,
} from '@gyblos/core/control-quotes';
import { CONTROL_CODES, REASONING_LEVELS } from '@gyblos/protocol/constants';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture.js';

void test('control rejects inconsistent engine context before invoking a signer', async () => {
  const fixture = await controlFixture();
  let calls = 0;
  const signer = async () => {
    calls++;
    return new Uint8Array(64);
  };
  for (const contextTokens of [64, 4096]) {
    fixture.context.models = [
      {
        ...fixture.context.models[0]!,
        model: { ...fixture.context.models[0]!.model, contextTokens },
      },
    ];
    await assert.rejects(
      createControlQuote(fixture.request, fixture.context, signer),
      { code: CONTROL_CODES.POLICY },
    );
  }
  assert.equal(calls, 0);
});
void test('control rejects catalog replacement or expiry during asynchronous signing', async () => {
  for (const expire of [false, true]) {
    const fixture = await controlFixture();
    await assert.rejects(
      createControlQuote(fixture.request, fixture.context, async (bytes) => {
        const signature = await fixture.ownerSigner(bytes);
        if (expire) fixture.setNow(fixture.context.readiness().validUntil);
        else
          fixture.context.catalog = {
            ...fixture.context.catalog,
            record: { ...fixture.catalog, sequence: 2 },
          };
        return signature;
      }),
      { code: expire ? CONTROL_CODES.EXPIRED : CONTROL_CODES.STALE },
    );
  }
});
void test('control supports exact reasoning levels only when catalog and engine both implement them', async () => {
  for (const level of Object.values(REASONING_LEVELS)) {
    const fixture = await controlFixture();
    fixture.catalog.models[0]!.reasoning = [level];
    fixture.context.catalog = await signPublicV2(
      fixture.catalog,
      fixture.nodeSigner,
    );
    fixture.request.params.catalogDigest = await catalogDigestV2(
      fixture.catalog,
    );
    fixture.request.params.reasoning = level;
    fixture.context.models = [
      { ...fixture.context.models[0]!, reasoning: [level] },
    ];
    const signed = await createControlQuote(
      fixture.request,
      fixture.context,
      fixture.ownerSigner,
    );
    assert.equal(
      (await acceptControlQuote(signed, fixture.request, fixture.trust()))
        .reasoning,
      level,
    );
  }
});
