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
    /\.sidebar-collapsed:not\(\.sidebar-moving\),\s*html\s+\.app\.desktop-frame\.sidebar-collapsed:not\(\.sidebar-moving\)\s+>\s+\.ui-window-chrome \{\s*background: var\(--pk-rail\);/,
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

void test('compact density is the default and ?density=comfortable restores the previous view', async () => {
  const [browser, css, kit, settings] = await Promise.all([
    read('browser.ts'),
    read('preview.css'),
    read('views/PreviewKit.tsx.preview'),
    read('views/Settings.tsx.preview'),
  ]);
  assert.match(browser, /get\('density'\) !== 'comfortable'/);
  for (const selector of [
    '.ui-select-trigger',
    '.preview-model-copy strong',
    '.preview-settings-rows > div > span',
    '.ui-tooltip',
  ])
    assert.ok(
      new RegExp(
        String.raw`html\[data-density='compact'\][^{]*` +
          selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          String.raw`[^{]*\{[^}]*font-size: var\(--ui-font\);`,
      ).test(css),
      selector,
    );
  assert.match(
    css,
    /html\[data-density='compact'\][^{]*\.ui-section-title h2[^{]*\{[^}]*font-size: 15px;/,
  );
  assert.match(
    css,
    /html\[data-density='compact'\][^{]*\.preview-metric-card dd > span[^{]*\{[^}]*font-size: 22px;/,
  );
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
    /aria-keyshortcuts=\{previewCompact\(\) \? previewShortcut\(PREVIEW_SHORTCUT\.NEW_CHAT\)\.aria/,
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

void test('compact loading and shortcut hints stay accessible', async () => {
  const kit = await read('views/PreviewKit.tsx.preview');
  assert.match(
    kit,
    /<span className="pk-skeleton-rows" role="status" aria-label="Loading conversations">/,
  );
  assert.match(kit, /<kbd className="pk-kbd" aria-hidden="true">/);
  assert.match(
    kit,
    /label="New chat"\s+aria-keyshortcuts=\{previewShortcut\(PREVIEW_SHORTCUT\.NEW_CHAT\)\.aria\}/,
  );
});

void test('compact pills, buttons, icons, digits and code line numbers', async () => {
  const [css, kit] = await Promise.all([
    read('preview.css'),
    read('views/PreviewKit.tsx.preview'),
  ]);
  const compact = (selector: string, declaration: string) =>
    assert.ok(
      new RegExp(
        String.raw`html\[data-density='compact'\][^{]*` +
          selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          String.raw`[^{]*\{[^}]*` +
          declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ).test(css.replace(/\s+/g, ' ')),
      selector + ' ' + declaration,
    );
  compact(
    ':is(.pk-tag, .ui-badge):not(.pk-badge-line .pk-tag)',
    'height: 18px;',
  );
  compact('.ui-badge', 'font-size: 11px;');
  compact('.ui-icon-tile', 'width: 28px;');
  compact('.ui-icon-tile', 'width: 16px;');
  compact('.preview-metric-icon', 'width: 24px;');
  compact(
    '.ui-button:not( .ui-icon-button, .ui-menu-trigger, .pk-switch, .pk-update, .theme-switch, dialog .ui-button )',
    '--control-size: 24px;',
  );
  assert.match(
    css,
    /html\[data-density='compact'\] \.app\.desktop-frame \{[^}]*--shell-control-size: 28px;/,
  );
  assert.match(
    css,
    /html\[data-font='inter'\] \.app\.desktop-frame \{\s*--preview-ui-type:\s*'Gyblos Digits', InterVariable/,
  );
  assert.match(
    css,
    /html\[data-font='inter'\] \.desktop-frame \{\s*font-family:\s*'Gyblos Digits', InterVariable/,
  );
  assert.match(kit, /className="pk-code-line"/);
  assert.match(
    css,
    /\.pk-code-line::before \{[^}]*counter-increment: pk-code-line;/,
  );
  assert.match(css, /\.pk-code-line::before \{[^}]*user-select: none;/);
  assert.match(
    css,
    /\.pk-code pre code \{[^}]*display: grid;[^}]*width: max-content;[^}]*min-width: 100%;/,
  );
  assert.match(css, /\.pk-code-line::before \{[^}]*padding-inline: 12px;/);
  assert.doesNotMatch(css, /\.pk-code-line::before \{[^}]*margin-right/);
});

void test('compact cards and connection steps use the compact scale', async () => {
  const css = (await read('preview.css')).replace(/\s+/g, ' ');
  const compact = (selector: string, declaration: string) =>
    assert.ok(
      new RegExp(
        String.raw`html\[data-density='compact'\][^{]*` +
          selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          String.raw`[^{]*\{[^}]*` +
          declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ).test(css),
      selector + ' ' + declaration,
    );
  compact('.preview-metric-card', 'padding: 12px 14px;');
  compact('.preview-metric-card', 'border-radius: var(--radius-panel);');
  compact('.preview-metric-card dt', 'font-size: var(--ui-detail);');
  compact('.preview-metric-card dd > span', 'font-size: 18px;');
  compact('.preview-metric-card dd > span', 'white-space: nowrap;');
  compact('.preview-tool-guide', 'padding: 16px;');
  compact('.preview-tool-logo', 'width: 28px;');
  compact('.preview-steps li > span', 'width: 20px;');
  compact('.preview-steps li > span svg', 'width: 12px;');
  compact('.preview-steps small', 'font-size: var(--ui-detail);');
  compact('.ui-help-text', 'font-size: var(--ui-detail);');
});

void test('the conversation panel slides under the rail like a stacked sheet', async () => {
  const css = (await read('preview.css')).replace(/\s+/g, ' ');
  assert.doesNotMatch(
    css,
    /\.sidebar-collapsed \.preview-chat-panel \{ display: none;/,
  );
  assert.match(
    css,
    /\.sidebar-collapsed \.preview-chat-panel \{[^}]*translate: -100% 0;[^}]*visibility: hidden;/,
  );
  assert.match(
    css,
    /prefers-reduced-motion: no-preference\) \{ \.desktop-frame \.preview-chat-panel \{ transition: translate var\(--motion-push\) var\(--motion-push-ease\)/,
  );
  assert.match(
    css,
    /\.app\.desktop-frame\.sidebar-collapsed:not\(\.sidebar-moving\), html \.app\.desktop-frame\.sidebar-collapsed:not\(\.sidebar-moving\) > \.ui-window-chrome \{ background: var\(--pk-rail\);/,
  );
  assert.match(css, /\.desktop-frame \.preview-rail \{[^}]*z-index: 1;/);
});
