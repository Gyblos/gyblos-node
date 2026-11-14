// Opt-in certified-prefix checks exercise the actual hash-pinned tokenizer with public temporary artifacts.
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { test } from 'node:test';

import { modelTokenizer } from '@gyblos/node/artifacts';

const artifactHome = process.env.GYBLOS_TEST_TOKENIZER_HOME;
async function tokenizer() {
  assert.ok(artifactHome && /^\/(private\/)?tmp\/gyb-paid-chat-tokenizer-[^/]+$/.test(artifactHome));
  const home = await realpath(artifactHome);
  assert.match(home, /^\/(private\/)?tmp\/gyb-paid-chat-tokenizer-[^/]+$/);
  return modelTokenizer({ GYBLOS_HOME: home });
}
const options = { skip: !artifactHome && 'Owned temporary public tokenizer artifacts required' };

void test('stable billing never signs the larger count of an unfinished BPE prefix', options, async () => {
  const meter = await tokenizer();
  assert.equal(meter.count('internationa'), 3);
  assert.equal(meter.count('internationalization'), 2);
  assert.deepEqual(meter.stablePrefix('internationa'), { characters: 0, tokens: 0 });
  assert.deepEqual(meter.stablePrefix('internationalization '), { characters: 20, tokens: 2 });
});
void test('stable billing observes but does not count the guard space', options, async () => {
  const meter = await tokenizer();
  for (const text of ['a ', 'hello world ', "we're safe ", 'a\u0301 b ', '\u1100\u1161 a ']) {
    const stable = meter.stablePrefix(text);
    assert.equal(stable.characters, text.length - 1);
    assert.equal(stable.tokens, meter.count(text.slice(0, stable.characters)));
    for (const suffix of ['a', '\u0301', "'re", '<|im_start|>', '\n', '你好']) {
      assert.ok(stable.tokens <= meter.count(text + suffix));
    }
  }
});
void test('an already complete added token and unbroken output need no intermediate bill', options, async () => {
  const meter = await tokenizer();
  assert.equal(meter.count('<|im_start'), 4);
  assert.equal(meter.count('<|im_start|>'), 1);
  for (const text of ['<|im_start', 'abcdefghijklmnopqrstuvwxyz'.repeat(30), '你好世界']) {
    assert.deepEqual(meter.stablePrefix(text), { characters: 0, tokens: 0 });
  }
});
void test('large engine fragments choose the earliest certified frontier reaching the target', options, async () => {
  const meter = await tokenizer();
  const text = 'one two three four five six seven eight nine ten ';
  const frontier = meter.stablePrefix(text, 3);
  assert.ok(frontier.characters > 0 && frontier.characters < text.length - 1);
  assert.ok(frontier.tokens >= 3);
  assert.equal(text[frontier.characters], ' ');
  for (let i = 0; i < frontier.characters; i++) {
    if (/[A-Za-z0-9]/.test(text[i]!) && text[i + 1] === ' ') assert.ok(meter.count(text.slice(0, i + 1)) < 3);
  }
});
