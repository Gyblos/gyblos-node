// Contextual buyer navigation uses no browser history, services or persistence.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  back,
  createNavigation,
  navigate,
  UI_VIEW,
} from '@gyblos/desktop/navigation-state';

void test('a contextual journey can return through Payments and Chat', () => {
  const chat = createNavigation();
  assert.equal(chat.current, UI_VIEW.CHAT);
  const payments = navigate(chat, UI_VIEW.PAYMENTS);
  const agents = navigate(payments, UI_VIEW.CONNECT);
  assert.equal(back(agents).current, UI_VIEW.PAYMENTS);
  assert.deepEqual(back(back(agents)), chat);
  assert.equal(back(chat), chat);
});

void test('sidebar destinations reset contextual history and links avoid cycles', () => {
  const chat = createNavigation();
  const payments = navigate(chat, UI_VIEW.PAYMENTS);
  assert.equal(navigate(payments, UI_VIEW.PAYMENTS), payments);
  assert.deepEqual(navigate(payments, UI_VIEW.CHAT), chat);
  const models = navigate(payments, UI_VIEW.MODELS, false);
  assert.deepEqual(models.history, []);
  assert.equal(back(models), models);
});

void test('primary navigation keeps the previous screen available for Back', () => {
  const payments = navigate(createNavigation(), UI_VIEW.PAYMENTS);
  const models = navigate(payments, UI_VIEW.MODELS, false);
  assert.equal(back(models).current, UI_VIEW.PAYMENTS);
});

void test('revisiting a route preserves chronological visits instead of discarding them', () => {
  const payments = navigate(createNavigation(), UI_VIEW.PAYMENTS);
  const chat = navigate(payments, UI_VIEW.CHAT);
  assert.equal(back(chat).current, UI_VIEW.PAYMENTS);
});
