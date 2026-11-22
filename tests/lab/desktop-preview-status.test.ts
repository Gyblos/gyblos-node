import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const preview = new URL('../../lab/tools/desktop-preview/', import.meta.url);
const read = (name: string) => readFile(new URL(name, preview), 'utf8');

void test('system status moves to a footer status bar with one checklist dialog', async () => {
  const build = await read('brand-build.ts');
  assert.match(build, /'Settings',\n\s+'SystemStatus',\n\s+\]\)/);
  assert.doesNotMatch(build, /src\/ui\/SystemStatus\.tsx`\)/);
  const sidebar = await read('views/BuyerSidebar.tsx.preview');
  assert.doesNotMatch(sidebar, /props\.systemStatus/);
  assert.match(build, /<PreviewStatusBar version=\{manifest\.version\}/);
  assert.match(build, /'<UpdateNotice \/>',\s*''/);
  const status = await read('views/SystemStatus.tsx.preview');
  assert.match(
    status,
    /useState\(\(\) => new URLSearchParams\(location\.search\)\.get\('review'\) === 'system-status'\)/,
  );
  assert.match(status, /className="preview-status-trigger"/);
  assert.match(status, /aria-haspopup="dialog"/);
  assert.match(status, /<MotionPresence>/);
  for (const label of ['Wallet', 'Recovery backup', 'Desktop app', 'Network'])
    assert.match(status, new RegExp(`label: '${label}'`));
  assert.match(status, /Sellers are checked when you send a message\./);
  assert.match(status, /openPreviewUpdate/);
  assert.match(status, /issues\[0\]\?\.summary/);
  assert.match(status, /usePreviewNewerVersion\(\)/);
  assert.doesNotMatch(status, /usePreviewUpdate/);
  assert.match(status, /summary: 'Wallet unavailable'/);
});

void test('the status bar shows the version and an update button only when a new version exists', async () => {
  const kit = await read('views/PreviewKit.tsx.preview');
  assert.match(kit, /export function PreviewStatusBar\(/);
  assert.match(kit, /export function PreviewUpdateButton\(/);
  assert.match(kit, /export function openPreviewUpdate\(/);
  assert.match(kit, /UPDATE: 'preview:update'/);
  assert.match(kit, /observeDesktopUpdates\(/);
  assert.match(kit, /DESKTOP_UPDATE\.OPEN/);
  assert.match(kit, /useSyncExternalStore\(subscribeUpdate, readUpdate\)/);
  assert.match(kit, /available && available !== version/);
  assert.match(kit, /<NewerVersion\.Provider value=\{newer\}>/);
  const host = await read('host.ts');
  assert.match(host, /query\.get\('update'\) === 'available'/);
  assert.match(host, /desktopUpdate,/);
  assert.match(host, /Pick<DesktopUpdate, 'available'>/);
  assert.doesNotMatch(await read('constants.ts'), /installedVersion/);
  const css = await read('preview.css');
  assert.match(css, /> \.preview-status-bar \{[^}]*grid-row: 3;/);
  assert.match(css, /--pk-status-bar: 28px;/);
  assert.doesNotMatch(css, /\.ui-status-item:last-child/);
  assert.doesNotMatch(css, /#app-sidebar \.modal/);
  const design = await read('DESIGN.md');
  assert.match(design, /`PreviewStatusBar`/);
  assert.match(design, /`PreviewUpdateButton`/);
  assert.match(design, /\| Status checklist /);
  const readme = await read('README.md');
  assert.match(readme, /`update=available`/);
});
