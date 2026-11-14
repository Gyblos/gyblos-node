// Stale Codex cleanup must retain recoverable bytes across ordinary concurrent editor saves.
// All profiles and editor changes belong to disposable homes; real agent settings are never accessed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { FILE_MODES } from '@gyblos/config';
import { AGENT_TOOLS, type AgentEndpoint } from '@gyblos/node/agent-setup';
import { writeAgentFile } from '@gyblos/node/agent-setup-host';

function endpoint(...ids: string[]): AgentEndpoint {
  return {
    origin: 'http://127.0.0.1:4031',
    models: ids.map((id) => ({ id, maxOutputTokens: 10 })),
  };
}

async function isolatedHome(context: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'agent-stale-save-'));
  const previousHome = process.env.GYBLOS_HOME;
  const previousLabHome = process.env.GYBLOS_LAB_HOME;
  process.env.GYBLOS_HOME = join(home, 'product');
  process.env.GYBLOS_LAB_HOME = join(home, 'lab');
  context.after(async () => {
    if (previousHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = previousHome;
    if (previousLabHome === undefined) delete process.env.GYBLOS_LAB_HOME;
    else process.env.GYBLOS_LAB_HOME = previousLabHome;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

for (const atomicSave of [false, true]) {
  void test(`stale cleanup preserves an editor's ${atomicSave ? 'atomic replacement' : 'in-place save'} after reading its snapshot`, async (context) => {
    const home = await isolatedHome(context);
    await writeAgentFile(AGENT_TOOLS.CODEX, endpoint('keep', 'old'), home, {});
    const directory = join(home, '.codex');
    const stale = join(directory, 'gyblos-old.config.toml');
    const originalText = await readFile(stale, 'utf8');
    const note = '# A concurrent manual edit\n';
    const edited = originalText + note;
    const originalRead = fs.promises.readFile;
    let saved = false;
    context.mock.method(
      fs.promises,
      'readFile',
      async (...args: Parameters<typeof originalRead>) => {
        const snapshot = await originalRead(...args);
        if (args[0] === stale && !saved) {
          saved = true;
          if (atomicSave) {
            const temporary = join(directory, 'editor-save.tmp');
            await writeFile(temporary, edited, {
              mode: FILE_MODES.privateFile,
            });
            await rename(temporary, stale);
          } else await appendFile(stale, note);
        }
        return snapshot;
      },
    );
    syncBuiltinESMExports();
    try {
      const result = await writeAgentFile(
        AGENT_TOOLS.CODEX,
        endpoint('keep'),
        home,
        {},
      );
      assert.equal(saved, true);
      const backups = result.profileBackups ?? [];
      assert.equal(
        backups.length,
        1,
        'a concurrently edited stale profile must remain recoverable',
      );
      assert.equal(await readFile(backups[0]!, 'utf8'), edited);
      assert.equal(await readFile(stale, 'utf8'), edited);
      assert.deepEqual(result.removed ?? [], []);
      assert.ok((await readdir(directory)).includes(basename(backups[0]!)));
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

void test('later stale cleanup never replaces an earlier profile backup', async (context) => {
  const home = await isolatedHome(context);
  await writeAgentFile(AGENT_TOOLS.CODEX, endpoint('keep', 'old'), home, {});
  const first = await writeAgentFile(
    AGENT_TOOLS.CODEX,
    endpoint('keep'),
    home,
    {},
  );
  const earlier = first.profileBackups ?? [];
  assert.equal(earlier.length, 1);
  const manual = '# A retained manual backup\n';
  await writeFile(earlier[0]!, manual);
  await writeAgentFile(AGENT_TOOLS.CODEX, endpoint('keep', 'old'), home, {});
  const second = await writeAgentFile(
    AGENT_TOOLS.CODEX,
    endpoint('keep'),
    home,
    {},
  );
  const later = second.profileBackups ?? [];
  assert.equal(later.length, 1);
  assert.notEqual(later[0], earlier[0]);
  assert.equal(await readFile(earlier[0]!, 'utf8'), manual);
  assert.match(await readFile(later[0]!, 'utf8'), /model = "old"/);
});
