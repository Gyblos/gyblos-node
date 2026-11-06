// Verifies public assistant handoffs: one canonical Markdown URL, URL-encoded prompts and no local context.
// Tests construct links only; no assistant, desktop app or external session is opened.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getAssistantLinks } from '@gyblos/docs/assistant-links';

void test('assistant links open the requested products with the canonical article in the prompt', () => {
  const path = '/markdown/es/sellers/beta-guide.md';
  const links = getAssistantLinks(path, true);
  assert.deepEqual(links.map((link) => link.name), ['ChatGPT', 'Claude', 'Claude Code', 'Cursor']);
  const expected = [
    ['https://chatgpt.com/', 'prompt'],
    ['https://claude.ai/new', 'q'],
    ['claude://code/new', 'q'],
    ['https://cursor.com/link/prompt', 'text'],
  ];
  for (const [index, link] of links.entries()) {
    const target = new URL(link.url);
    const [endpoint, parameter] = expected[index]!;
    assert.equal(`${target.protocol}//${target.host}${target.pathname}`, endpoint);
    const prompt = target.searchParams.get(parameter!);
    assert.ok(prompt?.includes(`https://docs.gyblos.com${path}`));
    assert.ok(prompt?.startsWith('Lee '));
    assert.doesNotMatch(link.url, /localhost|127\.0\.0\.1|folder=|repositories=|autoSubmit/);
  }
});

void test('assistant prompts follow the page language and preserve encoded paths', () => {
  const links = getAssistantLinks('/markdown/en/a%20page.md', false);
  const prompt = new URL(links[0]!.url).searchParams.get('prompt');
  assert.ok(prompt?.startsWith('Read '));
  assert.ok(prompt?.includes('/markdown/en/a%20page.md'));
  assert.equal(new URL(links[0]!.url).searchParams.get('hints'), 'search');
});
