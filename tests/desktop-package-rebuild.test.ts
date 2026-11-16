// Rebuilding the same release must not retain removed assets or an obsolete checksum.
// The packaging CLI runs with synthetic build assets and an unloaded fake native binding.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { WINDOWS } from '@gyblos/runtime/private-mode';

import { listZip, syntheticDesktopPackaging } from './support/desktop-packaging';

void test('rebuilding a desktop ZIP replaces obsolete app assets and its checksum', { skip: WINDOWS }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gyb-desktop-archive-'));
  try {
    const fixture = await syntheticDesktopPackaging(root);
    const obsolete = join(fixture.renderer, 'obsolete.js');
    await writeFile(obsolete, 'synthetic obsolete asset');
    await fixture.build();
    assert.match(await listZip(fixture.archive), /obsolete\.js/);
    await rm(obsolete);
    await writeFile(join(fixture.renderer, 'current.js'), 'synthetic current asset');
    await fixture.build();
    const entries = await listZip(fixture.archive);
    assert.doesNotMatch(entries, /obsolete\.js/);
    assert.match(entries, /current\.js/);
    const digest = createHash('sha256').update(await readFile(fixture.archive)).digest('hex');
    assert.equal(await readFile(`${fixture.archive}.sha256`, 'utf8'), `${digest}  ${basename(fixture.archive)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
