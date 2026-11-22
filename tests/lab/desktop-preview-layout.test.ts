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
  assert.match(host, /previewChatSeed\(seeded\)/);
  assert.match(sidebar, /<IconButton\n?\s*key=\{view\}/);
  assert.match(kit, /export function previewConversationRemoved\(/);
  assert.match(kit, /export function usePreviewConversationTitle\(/);
  assert.match(kit, /'\[aria-label="Show conversation details"\]'/);
  assert.match(kit, /getElementById\('preview-conversation-name'\)/);
  assert.match(kit, /event\.key === 'Escape'/);
  assert.doesNotMatch(kit, /preview-agents-entry" aria-current/);
  const activity = await read('views/ActivitySessions.tsx.preview');
  assert.match(activity, /!previewConversationRemoved\(match\.chat\.id\)/);
  for (const file of [
    'views/SpendingHistory.tsx.preview',
    'views/Activity.tsx.preview',
    'views/ActivitySessionDetails.tsx.preview',
  ]) {
    assert.match(await read(file), /previewConversationRemoved\(/, file);
  }
  assert.match(kit, /'\[aria-label="Search conversations"\]'/);
});

void test('the title bar adds a conversation menu and a details panel for the chat', async () => {
  const kit = await read('views/PreviewKit.tsx.preview');
  assert.match(kit, /export function PreviewConversationMenu\(/);
  for (const action of ['Rename', 'Copy as Markdown', 'Delete'])
    assert.match(kit, new RegExp(`label="${action}`));
  assert.match(kit, /export function PreviewChatDetails\(/);
  const build = await read('brand-build.ts');
  const layout = await read('layout-build.ts');
  assert.match(layout, /<PreviewConversationMenu chat=\{props\.chat\}/);
  assert.match(layout, /<PreviewChatDetails chat=\{chatController\}/);
  assert.match(layout, /'Hide conversation details'/);
  assert.match(layout, /usePreviewConversationTitle\(conversation\)/);
  assert.match(build, /layout\.TITLEBAR_REWRITES/);
  const css = await read('preview.css');
  assert.match(css, /\.preview-rail \{/);
  assert.match(
    css,
    /\.preview-rail-item\.ui-icon-button\[aria-current='page'\]/,
  );
  assert.doesNotMatch(
    css,
    /max-width: 899px\) \{\n  \.desktop-frame \.preview-chat-panel/,
  );
  assert.match(css, /\.preview-chat-state\[data-state='running'\]/);
  const design = await read('DESIGN.md');
  assert.match(design, /PreviewConversationPanel/);
  assert.match(design, /PreviewChatDetails/);
});
