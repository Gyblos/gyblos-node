// Exercises complete UI catalog and context navigation with synthetic local data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  matchesCatalog,
  MODE_NAV,
  MODEL_FILTER,
  MODELS,
  UI_VIEW,
} from '@gyblos/desktop/catalog-state';
import {
  authorizeDemo,
  DEMO_ACCOUNT,
  DEMO_AUTH,
} from '@gyblos/desktop/demo-account';

void test('desktop full catalog exposes all five model families with local artwork', () => {
  assert.equal(MODELS.length, 5);
  assert.equal(new Set(MODELS.map((item) => item.id)).size, 5);
  for (const item of MODELS)
    assert.ok(item.image.src.startsWith('./assets/models/'));
});
void test('desktop catalog searches model and family without case or outer whitespace', () => {
  assert.deepEqual(
    MODELS.filter((item) => matchesCatalog(item, ' OPENAI ', MODEL_FILTER.ALL)),
    [MODELS[1]],
  );
});
void test('desktop catalog free filter excludes paid illustrative offers', () => {
  assert.deepEqual(
    MODELS.filter((item) => matchesCatalog(item, '', MODEL_FILTER.FREE)),
    MODELS.slice(0, 2),
  );
});
void test('desktop catalog category and search combine rather than override each other', () => {
  assert.equal(
    MODELS.filter((item) =>
      matchesCatalog(item, 'deepseek', MODEL_FILTER.CODING),
    ).length,
    1,
  );
  assert.equal(
    MODELS.filter((item) =>
      matchesCatalog(item, 'deepseek', MODEL_FILTER.REASONING),
    ).length,
    0,
  );
});
void test('desktop contextual navigation shares Models and Activity without duplicate modes', () => {
  assert.equal(MODE_NAV.Chat[0].name, UI_VIEW.CHAT);
  assert.equal(MODE_NAV.Connect[0].name, UI_VIEW.CONNECT);
  assert.deepEqual(
    MODE_NAV.Chat.filter((item) => item.name !== UI_VIEW.TOOLS).slice(1),
    MODE_NAV.Connect.slice(1),
  );
  assert.equal(MODE_NAV.Chat.at(-1)?.name, UI_VIEW.TOOLS);
});
void test('desktop demo free request succeeds with no credits and a zero limit', () => {
  assert.equal(
    authorizeDemo({ credits: 0, spent: 0, budget: 0 }, true, true).status,
    DEMO_AUTH.APPROVED,
  );
});
void test('desktop demo paid request cannot consume missing credits', () => {
  const account = { credits: 0, spent: 0, budget: 2 };
  assert.deepEqual(authorizeDemo(account, false, true), {
    status: DEMO_AUTH.BALANCE,
    ...account,
  });
});
void test('desktop demo account refuses over-limit and offline requests without mutation', () => {
  const account = { credits: 10, spent: 2, budget: 2 };
  assert.deepEqual(authorizeDemo(account, false, true), {
    status: DEMO_AUTH.LIMIT,
    ...account,
  });
  assert.deepEqual(authorizeDemo(account, true, false), {
    status: DEMO_AUTH.OFFLINE,
    ...account,
  });
});
void test('desktop demo request increments illustrative usage by its fixed simulation cost', () => {
  const result = authorizeDemo(
    { credits: DEMO_ACCOUNT.TOP_UP, spent: 0, budget: 2 },
    false,
    true,
  );
  assert.equal(result.status, DEMO_AUTH.APPROVED);
  assert.equal(result.spent, DEMO_ACCOUNT.REQUEST_COST);
  assert.equal(result.credits, DEMO_ACCOUNT.TOP_UP - DEMO_ACCOUNT.REQUEST_COST);
});

void test('desktop free demo requests bypass a limit reduced below prior spending', () => {
  const account = { credits: 0, spent: 1, budget: 0 };
  assert.deepEqual(authorizeDemo(account, true, true), {
    status: DEMO_AUTH.APPROVED,
    ...account,
  });
});
void test('desktop demo accepts the exact daily limit before refusing the next charge', () => {
  let account = { credits: 1, spent: 0, budget: 0.01 };
  for (let index = 0; index < 10; index += 1) {
    const result = authorizeDemo(account, false, true);
    assert.equal(result.status, DEMO_AUTH.APPROVED);
    account = {
      credits: result.credits,
      spent: result.spent,
      budget: result.budget,
    };
  }
  assert.equal(account.spent, account.budget);
  assert.equal(account.credits, 0.99);
  assert.deepEqual(authorizeDemo(account, false, true), {
    status: DEMO_AUTH.LIMIT,
    ...account,
  });
});
