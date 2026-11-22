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
  assert.match(
    css,
    /prefers-reduced-motion: reduce\) \{\s*\.desktop-frame \.preview-chat-state\[data-state='running'\] \{\s*animation: none;/,
  );
  assert.match(
    css,
    /> \.app-body \{[^}]*border-start-start-radius: var\(--pk-radius-sheet\);/,
  );
  assert.doesNotMatch(css, /--pk-side-width/);
  assert.match(
    css,
    /\.preview-chat-panel \{[^}]*border-inline-start: 1px solid var\(--line\);[^}]*border-end-start-radius: var\(--pk-radius-sheet\);/s,
  );
  assert.match(
    css,
    /\.sidebar-collapsed,\s*html \.app\.desktop-frame\.sidebar-collapsed > \.ui-window-chrome \{\s*background: var\(--pk-rail\);/,
  );
  assert.doesNotMatch(
    css,
    /> \.preview-status-bar \{[^}]*border-start-(start|end)-radius/s,
  );
  assert.match(css, /animation: pk-agents-border 2\.5s linear infinite;/);
  assert.doesNotMatch(
    css,
    /\.preview-agents-entry:hover:not\(:disabled\) \{[^}]*animation/s,
  );
  assert.match(
    css,
    /\.preview-chat-pin,\s*html \.app\.desktop-frame \.preview-chat-pin\[aria-pressed='true'\] \{\s*opacity: 1;/,
  );
  assert.match(
    css,
    /html \.app\.desktop-frame \.preview-chat-pin \{\s*position: absolute;\s*right: 6px;\s*width: 20px;\s*min-width: 20px;/,
  );
  assert.match(
    css,
    /prefers-reduced-motion: reduce\) \{\s*html \.app\.desktop-frame \.preview-agents-entry \{\s*animation: none;/,
  );
  assert.match(css, /\.preview-new-chat, \.preview-agents-entry\)/);
  assert.match(
    css,
    /\.preview-chat-panel-head \{[^}]*border-block-start: 1px solid var\(--line\);/s,
  );
  const design = await read('DESIGN.md');
  assert.match(design, /PreviewConversationPanel/);
  assert.match(design, /PreviewChatDetails/);
});

void test('?density=compact is a comparison mode that leaves the default view unchanged', async () => {
  const [browser, css, kit, settings] = await Promise.all([
    read('browser.ts'),
    read('preview.css'),
    read('views/PreviewKit.tsx.preview'),
    read('views/Settings.tsx.preview'),
  ]);
  assert.match(browser, /get\('density'\) === 'compact'/);
  assert.match(browser, /dataset\.density = 'compact'/);
  assert.match(browser, /compact && !query\.has\('font'\)/);
  const tokens =
    /html\[data-density='compact'\] \.app\.desktop-frame \{([^}]*)\}/.exec(
      css,
    )?.[1] ?? '';
  for (const token of [
    '--radius-control: 6px;',
    '--radius-option: 6px;',
    '--pk-radius-menu: 8px;',
    '--radius-panel: 10px;',
    '--pk-radius-sheet: 16px;',
    '--control-size: 28px;',
    '--pk-row-height: 30px;',
    '--pk-comfort-padding: 20px;',
  ])
    assert.ok(tokens.includes(token), token);
  assert.match(css, /--pk-radius-sheet: var\(--radius-panel\);/);
  assert.match(css, /border-start-start-radius: var\(--pk-radius-sheet\);/);
  assert.match(
    css,
    /html\[data-density='compact'\][^{]*\{[^}]*transition-duration: 150ms;/,
  );
  assert.match(
    css,
    /prefers-reduced-motion: reduce\) \{\s*html\[data-density='compact'\]/,
  );
  for (const name of [
    'previewCompact',
    'previewIcon',
    'Kbd',
    'showPreviewToast',
    'PreviewToaster',
    'PreviewSkeletonRows',
    'PreviewEmptyLine',
  ])
    assert.match(
      kit,
      new RegExp('export (function|const) ' + name + '\\b'),
      name,
    );
  assert.match(kit, /previewCompact\(\) \? 1000 : 1600/);
  assert.match(kit, /size: 16, weight: 'bold'/);
  assert.match(
    kit,
    /aria-keyshortcuts=\{previewCompact\(\) \? PREVIEW_SHORTCUT\.NEW_CHAT\.aria/,
  );
  assert.match(kit, /NEW_CHAT: \{ label: '⌘N', aria: 'Meta\+N' \}/);
  assert.match(kit, /MODELS: \{ label: '⌘K', aria: 'Meta\+K' \}/);
  assert.doesNotMatch(kit, /addEventListener\('keydown', onKey\)/);
  const details = await read('views/UsdcApiKeyDetails.tsx.preview');
  assert.match(
    details,
    /if \(result && !result\.error\) showPreviewToast\('API key revoked'\)/,
  );
  const sidebar = await read('views/BuyerSidebar.tsx.preview');
  assert.match(sidebar, /shortcut: PREVIEW_SHORTCUT\.MODELS/);
  assert.match(
    settings,
    /else if \(previewCompact\(\)\) params\.set\('font', 'instrument-sans'\)/,
  );
  assert.match(kit, /showPreviewToast\('Conversation deleted'\)/);
  assert.match(
    settings,
    /<Section title="Appearance" icon=\{<PreviewSectionIcon icon=\{Palette\} \/>\}>/,
  );
});
