// Desktop agents use exactly the shared generator and writer for the connected buyer's real model list.
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  parseUsdcApiState,
  USDC_API_ACTION,
} from '@gyblos/desktop/usdc-api-model';
import {
  AGENT_TOOLS,
  agentFilePath,
  codexProfiles,
} from '@gyblos/node/agent-setup';
import { agentText } from '@gyblos/node/agent-setup-host';

import { desktopAgentFixture } from './support/desktop-agent';

void test('desktop previews all buyer models for each agent without exposing credentials or calling inference', async (t) => {
  const f = await desktopAgentFixture();
  t.after(() => f.close());
  for (const tool of Object.values(AGENT_TOOLS)) {
    const result = await f.run(USDC_API_ACTION.PREVIEW_AGENT, tool);
    assert.equal(result.error, null);
    assert.equal(
      result.setup?.text,
      agentText(tool, {
        origin: f.origin,
        models: f.models.map((model) => ({
          id: model.id,
          maxOutputTokens: model.maxTokens,
        })),
        tokenEnv: 'GYBLOS_API_KEY',
      }),
    );
    assert.deepEqual(
      result.setup?.models,
      f.models.map((model) => model.id),
    );
    assert.ok(!JSON.stringify(result).includes(f.token));
    assert.doesNotMatch(JSON.stringify(result), /gyb_[A-Za-z0-9_-]+/);
    if (tool === AGENT_TOOLS.CODEX)
      assert.match(result.setup?.text ?? '', /wire_api = "responses"/);
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
  assert.doesNotMatch(
    f.copied.at(-1) ?? '',
    /synthetic-private-owner-token|gyb_[A-Za-z0-9_-]+/,
  );
  for (const _ of [1, 2]) {
    const written = await f.run(USDC_API_ACTION.WRITE_AGENT, AGENT_TOOLS.PI);
    assert.equal(written.error, null);
    assert.doesNotThrow(() => parseUsdcApiState(written));
    assert.equal(written.setup?.path, path);
  }
  assert.equal(await readFile(`${path}.before-gyblos`, 'utf8'), original);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, 'utf8'), /personal/);
  assert.match(await readFile(path, 'utf8'), /synthetic-other/);
  assert.match(await readFile(path, 'utf8'), /\$GYBLOS_API_KEY/);
  assert.equal(f.generations(), 0);
});

void test('one app-created key switches between the buyer models through the shared Responses endpoint', async (t) => {
  const f = await desktopAgentFixture({ inference: true });
  t.after(() => f.close());
  const setup = await f.run(USDC_API_ACTION.PREVIEW_AGENT, AGENT_TOOLS.CODEX);
  assert.equal(setup.error, null);
  assert.equal(f.generations(), 0);
  const copied = await f.run(USDC_API_ACTION.COPY_KEY);
  assert.equal(copied.error, null);
  const token = f.copied.at(-1);
  assert.ok(token);
  assert.ok(!JSON.stringify(copied).includes(token));
  for (const model of f.models) {
    const response: Response = await fetch(new URL('/v1/responses', f.origin), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model.id,
        input: 'synthetic',
        max_output_tokens: 8,
      }),
    });
    assert.equal(response.status, 200);
    const result: unknown = await response.json();
    assert.ok(
      result &&
        typeof result === 'object' &&
        'model' in result &&
        'status' in result,
    );
    assert.equal(result.model, model.id);
    assert.equal(result.status, 'completed');
  }
  assert.equal(f.generations(), 2);
});

void test('desktop Codex writes the current separate profile files and validates their IPC metadata', async (t) => {
  const f = await desktopAgentFixture();
  t.after(() => f.close());
  const written = await f.run(USDC_API_ACTION.WRITE_AGENT, AGENT_TOOLS.CODEX);
  assert.equal(written.error, null);
  assert.doesNotThrow(() => parseUsdcApiState(written));
  const state = parseUsdcApiState(written);
  const profiles = codexProfiles({
    origin: f.origin,
    models: f.models.map((model) => ({
      id: model.id,
      maxOutputTokens: model.maxTokens,
    })),
    tokenEnv: 'GYBLOS_API_KEY',
  });
  const expected = profiles.map((profile) =>
    join(f.environment.CODEX_HOME, profile.file),
  );
  assert.deepEqual(state.setup?.profiles, expected);
  const config = await readFile(
    join(f.environment.CODEX_HOME, 'config.toml'),
    'utf8',
  );
  assert.doesNotMatch(config, /\[profiles\./);
  assert.match(config, /wire_api = "responses"/);
  for (const profile of profiles) {
    const path = join(f.environment.CODEX_HOME, profile.file);
    assert.equal(await readFile(path, 'utf8'), profile.text);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.equal(f.generations(), 0);
});
