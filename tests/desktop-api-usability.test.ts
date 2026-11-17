// Synthetic buyer errors and ephemeral delegated keys; no real profile, prompt, payment or remote service.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { desktopBuyerFailure } from '@gyblos/desktop/buyer-error';
import { emptyUsdcApi, usdcApiKeyBadge, USDC_API_ACTION } from '@gyblos/desktop/usdc-api-model';
import { FREE_EXECUTION_CODES, FREE_EXECUTION_STOP_REASONS } from '@gyblos/protocol/constants';

import { desktopAgentFixture } from './support/desktop-agent';
import { policy } from './support/desktop-stream';

void test('free seller selection does not tell a free-only buyer to add funds', () => {
  const error = desktopBuyerFailure({ code: SELLER_SELECTION_CODES.PRICE_ABOVE_BUDGET, message: 'SYNTHETIC_SECRET_CANARY' }, policy);
  assert.match(error.message, /No free seller is available/);
  assert.doesNotMatch(error.message, /CANARY|fund|raise|SELLER_PRICE/);
});
void test('timeout and free allowance failures explain an action without reflecting remote messages', () => {
  assert.match(desktopBuyerFailure({ code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE, reason: FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT }, policy).message, /time|shorten/i);
  assert.match(desktopBuyerFailure({ code: FREE_EXECUTION_CODES.BUYER_CAP }, policy).message, /allowance|later/i);
});
void test('a zero-budget key is labelled free-only while revoked and uncertain state still take precedence', async (t) => {
  const fixture = await desktopAgentFixture();
  t.after(() => fixture.close());
  const state = await fixture.run(USDC_API_ACTION.COPY_URL);
  const key = state.snapshot!.keys[0]!;
  assert.equal(usdcApiKeyBadge(state, key), 'Free only');
  assert.equal(usdcApiKeyBadge({ ...state, error: 'unavailable' }, key), 'Needs review');
  assert.equal(usdcApiKeyBadge({ ...state, snapshot: { ...state.snapshot!, blocked: true } }, key), 'Needs review');
  assert.equal(usdcApiKeyBadge(emptyUsdcApi(), { ...key, revoked: true }), 'Revoked');
});
void test('revealing a key is explicit, main-frame scoped, transient and unavailable after revocation', async (t) => {
  const fixture = await desktopAgentFixture();
  t.after(() => fixture.close());
  const input = { id: fixture.id, policyId: fixture.client.policy()!.policyId };
  const reveal = await fixture.host.reveal(fixture.event, [input]);
  assert.equal(reveal.id, fixture.id);
  assert.equal(reveal.policyId, input.policyId);
  assert.match(reveal.secret, /^gyb_/);
  const state = await fixture.run(USDC_API_ACTION.COPY_URL);
  assert.ok(!JSON.stringify(state).includes(reveal.secret));
  await assert.rejects(fixture.host.reveal({ ...fixture.event, senderFrame: {} }, [input]));
  await assert.rejects(fixture.host.reveal(fixture.event, [{ ...input, secret: 'injected' }]));
  await fixture.run(USDC_API_ACTION.REVOKE);
  await assert.rejects(fixture.host.reveal(fixture.event, [input]));
  fixture.host.close();
  await assert.rejects(fixture.host.reveal(fixture.event, [input]));
});
