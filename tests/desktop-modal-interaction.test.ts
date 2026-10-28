// Guards modal dismissal during text editing and intentional backdrop interaction.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createModalDismissal } from '@gyblos/desktop/modal-model';

const bounds = { left: 100, top: 100, right: 500, bottom: 400 };
const outside = {
  pointerId: 1,
  button: 0,
  isPrimary: true,
  clientX: 50,
  clientY: 150,
};
const inside = { ...outside, clientX: 120 };
void test('editing gestures and dialog padding never dismiss a modal', () => {
  const modal = createModalDismissal();
  modal.start(inside, bounds);
  assert.equal(modal.end(outside, bounds), false);
  modal.start(inside, bounds);
  assert.equal(modal.end(inside, bounds), false);
  assert.equal(modal.end(outside, bounds), false);
});
void test('only a matching primary backdrop press and release dismisses', () => {
  const modal = createModalDismissal();
  modal.start(outside, bounds);
  assert.equal(modal.end(outside, bounds), true);
  modal.start(outside, bounds);
  assert.equal(modal.end(inside, bounds), false);
  modal.start(outside, bounds);
  assert.equal(modal.end({ ...outside, pointerId: 2 }, bounds), false);
  modal.start({ ...outside, button: 2 }, bounds);
  assert.equal(modal.end(outside, bounds), false);
  modal.start({ ...outside, isPrimary: false }, bounds);
  assert.equal(modal.end(outside, bounds), false);
  modal.start(outside, bounds);
  modal.cancel();
  assert.equal(modal.end(outside, bounds), false);
});
