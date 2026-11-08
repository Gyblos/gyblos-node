// Setup failure hints remain static and explain preservation without exposing arbitrary exceptions.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buyerInitMessage } from '@gyblos/buyer/init';
import { BuyerInitError } from '@gyblos/node/buyer-init';
import { BUYER_INIT_CODES } from '@gyblos/node/buyer-init-constants';

void test('initialization failure hints explain existing settings and incompatible-role recovery', () => {
  const existing = buyerInitMessage(new BuyerInitError(BUYER_INIT_CODES.EXISTS));
  assert.match(existing, /edit.*selection\.json/i);
  assert.match(existing, /preserv/i);
  const unavailable = buyerInitMessage(new BuyerInitError(BUYER_INIT_CODES.UNAVAILABLE));
  assert.match(unavailable, /another mint/);
  assert.match(unavailable, /GYBLOS_HOME/);
  assert.match(unavailable, /keep.*old home/i);
});
void test('unrecognized initialization errors never print their contents', () => {
  const message = buyerInitMessage(new Error('synthetic-private-value'));
  assert.doesNotMatch(message, /synthetic-private-value/);
  assert.match(message, /preserved/);
});
