// Desktop agents use exactly the shared generator and writer for the connected buyer's real model list.
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';

import { USDC_API_ACTION } from '@gyblos/desktop/usdc-api-model';
import { AGENT_TOOLS, agentFilePath } from '@gyblos/node/agent-setup';
import { agentText } from '@gyblos/node/agent-setup-host';

import { desktopAgentFixture } from './support/desktop-agent';

void test('desktop previews all buyer models for each agent without exposing credentials or calling inference', async (t) => {
  const f = await desktopAgentFixture();
  t.after(() => f.close());
  for (const tool of Object.values(AGENT_TOOLS)) {
    const result = await f.run(USDC_API_ACTION.PREVIEW_AGENT, tool);
    assert.equal(result.error, null);
    assert.equal(result.setup?.text, agentText(tool, { origin: f.origin, models: f.models.map((model) => ({ id: model.id, maxOutputTokens: model.maxTokens })), tokenEnv: 'GYBLOS_API_KEY' }));
    assert.deepEqual(result.setup?.models, f.models.map((model) => model.id));
    assert.ok(!JSON.stringify(result).includes(f.token));
    assert.doesNotMatch(JSON.stringify(result), /gyb_[A-Za-z0-9_-]+/);
    if (tool === AGENT_TOOLS.CODEX) assert.match(result.setup?.text ?? '', /wire_api = "responses"/);
  }
  assert.equal(f.generations(), 0);
});

void test('desktop copies generated references and writes only its host-selected file with the first private backup', async (t) => {
  const f = await desktopAgentFixture();
  t.after(() => f.close());
  const path = agentFilePath(AGENT_TOOLS.PI, f.home, f.environment);
  const original = '{"providers":{"personal":{"api":"other"}}}\n';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, original, { mode: 0o600 });
  const copied = await f.run(USDC_API_ACTION.COPY_AGENT, AGENT_TOOLS.PI);
  assert.equal(copied.error, null);
  assert.equal(f.copied.at(-1), copied.setup?.text);
  assert.doesNotMatch(f.copied.at(-1) ?? '', /synthetic-private-owner-token|gyb_[A-Za-z0-9_-]+/);
  for (const _ of [1, 2]) {
    const written = await f.run(USDC_API_ACTION.WRITE_AGENT, AGENT_TOOLS.PI);
    assert.equal(written.error, null);
    assert.equal(written.setup?.path, path);
  }
  assert.equal(await readFile(`${path}.before-gyblos`, 'utf8'), original);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, 'utf8'), /personal/);
  assert.match(await readFile(path, 'utf8'), /synthetic-other/);
  assert.match(await readFile(path, 'utf8'), /\$GYBLOS_API_KEY/);
  assert.equal(f.generations(), 0);
});
