import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const preview = new URL('../../lab/tools/desktop-preview/', import.meta.url);
const read = (name: string) => readFile(new URL(name, preview), 'utf8');

void test('the sidebar splits into an icon rail and a conversation panel with pinned and dated groups', async () => {
  const sidebar = await read('views/BuyerSidebar.tsx.preview');
  assert.match(sidebar, /className="preview-rail"/);
  assert.match(sidebar, /<PreviewConversationPanel/);
  assert.doesNotMatch(sidebar, /<Badge>API<\/Badge>/);
  const kit = await read('views/PreviewKit.tsx.preview');
  assert.match(kit, /export function PreviewConversationPanel\(/);
  for (const group of [
    'Pinned',
    'Today',
    'Yesterday',
    'Previous 7 days',
    'Older',
  ])
    assert.match(kit, new RegExp(`'${group}'`));
  assert.match(kit, /export function PreviewAgentLogos\(/);
  assert.match(kit, /Connect agents/);
  assert.match(kit, /data-state=\{state\}/);
  assert.match(kit, /markUnread\(/);
  const host = await read('host.ts');
  assert.match(host, /previewChatSeed/);
});

void test('the title bar adds a conversation menu and a details panel for the chat', async () => {
  const kit = await read('views/PreviewKit.tsx.preview');
  assert.match(kit, /export function PreviewConversationMenu\(/);
  for (const action of ['Rename', 'Copy as Markdown', 'Delete'])
    assert.match(kit, new RegExp(`label="${action}`));
  assert.match(kit, /export function PreviewChatDetails\(/);
  const build = await read('brand-build.ts');
  assert.match(build, /<PreviewConversationMenu chat=\{props\.chat\}/);
  assert.match(build, /<PreviewChatDetails chat=\{chatController\}/);
  assert.match(build, /'Hide conversation details'/);
  const css = await read('preview.css');
  assert.match(css, /\.preview-rail \{/);
  assert.match(css, /\.preview-chat-state\[data-state='running'\]/);
  const design = await read('DESIGN.md');
  assert.match(design, /PreviewConversationPanel/);
  assert.match(design, /PreviewChatDetails/);
});
