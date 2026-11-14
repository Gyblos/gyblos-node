// Profile cleanup preserves active names, manual edits and a complete result under concurrent writers.
// All coding-agent directories are synthetic children of disposable homes, never the user's settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AGENT_TOOLS, type AgentEndpoint } from '@gyblos/node/agent-setup';
import { writeAgentFile } from '@gyblos/node/agent-setup-host';

function endpoint(...ids: string[]): AgentEndpoint {
  return {
    origin: 'http://127.0.0.1:4031',
    models: ids.map((id) => ({ id, maxOutputTokens: 10 })),
  };
}

async function isolatedHome(context: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cleanup-regression-'));
  const originalDirectory = process.cwd();
  const originalHome = process.env.GYBLOS_HOME;
  const originalLabHome = process.env.GYBLOS_LAB_HOME;
  process.chdir(directory);
  process.env.GYBLOS_HOME = join(directory, 'product');
  process.env.GYBLOS_LAB_HOME = join(directory, 'lab');
  context.after(async () => {
    process.chdir(originalDirectory);
    if (originalHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = originalHome;
    if (originalLabHome === undefined) delete process.env.GYBLOS_LAB_HOME;
    else process.env.GYBLOS_LAB_HOME = originalLabHome;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

void test('case-only model changes retain the newly written active profile', async (context) => {
  const home = await isolatedHome(context);
  const probe = join(home, 'CaseProbe');
  await writeFile(probe, 'Synthetic filesystem capability probe');
  const insensitive = await stat(join(home, 'caseprobe')).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    },
  );
  await rm(probe);
  if (!insensitive) {
    context.skip('case-insensitive filesystem required');
    return;
  }
  await writeAgentFile(AGENT_TOOLS.CODEX, endpoint('Qwen3'), home, {});
  const result = await writeAgentFile(
    AGENT_TOOLS.CODEX,
    endpoint('qwen3'),
    home,
    {},
  );
  const active = join(home, '.codex', 'gyblos-qwen3.config.toml');
  assert.match(await readFile(active, 'utf8'), /model = "qwen3"/);
  assert.deepEqual(result.removed ?? [], []);
});

void test('stale cleanup keeps a managed profile after manual field or comment edits', async (context) => {
  const home = await isolatedHome(context);
  await writeAgentFile(AGENT_TOOLS.CODEX, endpoint('keep', 'old'), home, {});
  const stale = join(home, '.codex', 'gyblos-old.config.toml');
  const original = await readFile(stale, 'utf8');
  const edited =
    original.replace('model = "old"', 'model = "my-custom-model"') +
    '# My manual note\n';
  await writeFile(stale, edited);
  const result = await writeAgentFile(
    AGENT_TOOLS.CODEX,
    endpoint('keep'),
    home,
    {},
  );
  assert.equal(await readFile(stale, 'utf8'), edited);
  assert.deepEqual(result.removed ?? [], []);
});
