// Agent configuration updates preserve user tables and keep synthetic credentials private at first write.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import promises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeAgentFile } from '@gyblos/buyer/agent-cli';
import {
  AGENT_TOOLS,
  CODEX_MARKS,
  codexBlock,
  mergedCodexConfig,
} from '@gyblos/node/agent-setup';

const ENDPOINT = {
  origin: 'http://127.0.0.1:4031',
  models: [{ id: 'qwen3-0.6b', maxOutputTokens: 10 }],
};
void test('adding a model refuses an outside profile collision without changing the file or creating a backup', async (t) => {
  const home = await promises.mkdtemp(join(tmpdir(), 'gyb-agent-collision-'));
  t.after(() => promises.rm(home, { recursive: true, force: true }));
  const directory = join(home, '.codex');
  await promises.mkdir(directory);
  const file = join(directory, 'config.toml');
  const existing =
    codexBlock(ENDPOINT) +
    '\n[profiles."gyblos-gpt-oss-20b"]\nmodel = "user-model"\n';
  await promises.writeFile(file, existing, { mode: 0o600 });
  await assert.rejects(
    writeAgentFile(
      AGENT_TOOLS.CODEX,
      {
        ...ENDPOINT,
        models: [
          ...ENDPOINT.models,
          { id: 'gpt-oss-20b', maxOutputTokens: 20 },
        ],
      },
      home,
    ),
    { code: 'FILE' },
  );
  assert.equal(await promises.readFile(file, 'utf8'), existing);
  assert.deepEqual(await promises.readdir(directory), ['config.toml']);
});
void test('unrelated tables inside a managed block are refused instead of deleted', () => {
  const existing = codexBlock(ENDPOINT).replace(
    CODEX_MARKS.end,
    '[mcp_servers.user_added]\ncommand = "user-command"\n' + CODEX_MARKS.end,
  );
  assert.throws(() => mergedCodexConfig(ENDPOINT, existing), { code: 'FILE' });
});
void test('duplicate and non-standalone managed markers are refused', () => {
  const block = codexBlock(ENDPOINT);
  for (const existing of [
    block + '\n' + block,
    block.replace(CODEX_MARKS.start, '# prefix ' + CODEX_MARKS.start),
    block.replace(CODEX_MARKS.end, CODEX_MARKS.end + ' trailing'),
  ])
    assert.throws(() => mergedCodexConfig(ENDPOINT, existing), {
      code: 'FILE',
    });
});
void test('temporary merged files are private immediately after writing, before any later chmod', async (t) => {
  const home = await promises.mkdtemp(join(tmpdir(), 'gyb-agent-private-'));
  t.after(() => promises.rm(home, { recursive: true, force: true }));
  const directory = join(home, '.pi/agent');
  await promises.mkdir(directory, { recursive: true });
  const file = join(directory, 'models.json');
  await promises.writeFile(
    file,
    '{"providers":{"other":{"apiKey":"synthetic-token"}}}',
    { mode: 0o600 },
  );
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import promises from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    const original=promises.writeFile;let observed;
    promises.writeFile=async(...args)=>{await original(...args);if(typeof args[0]==='string'&&args[0].endsWith('.tmp'))observed=(await promises.stat(args[0])).mode&0o777;};
    syncBuiltinESMExports();
    const {writeAgentFile}=await import('@gyblos/buyer/agent-cli');
    await writeAgentFile('pi',JSON.parse(process.env.GYBLOS_TEST_ENDPOINT),process.env.GYBLOS_TEST_HOME);
    assert.equal(observed,0o600);
  `,
    ],
    {
      env: {
        PATH: process.env.PATH,
        GYBLOS_TEST_HOME: home,
        GYBLOS_TEST_ENDPOINT: JSON.stringify(ENDPOINT),
      },
      stdio: 'pipe',
    },
  );
  assert.equal(
    (await promises.stat(file + '.before-gyblos')).mode & 0o777,
    0o600,
  );
});
void test('new agent configuration files are private by default', async (t) => {
  const home = await promises.mkdtemp(join(tmpdir(), 'gyb-agent-new-'));
  t.after(() => promises.rm(home, { recursive: true, force: true }));
  const result = await writeAgentFile(AGENT_TOOLS.PI, ENDPOINT, home);
  assert.equal((await promises.stat(result.path)).mode & 0o777, 0o600);
});
