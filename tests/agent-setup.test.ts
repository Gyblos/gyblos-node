// Connecting coding agents to a local buyer from one source: every served model with its limits for
// OpenCode, pi, Codex CLI and Claude Code; files merged keeping everything but the gyblos provider; a
// managed Codex block replaced in place; a paid token referenced by name only; non-loopback endpoints
// and hand-edited files refused. Temporary homes only; no real configuration is touched.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { agentText, writeAgentFile } from '@gyblos/buyer/agent-cli';
import {
  AGENT_TOOLS,
  claudeCodeEnvironment,
  CODEX_MARKS,
  codexBlock,
  mergedAgentFile,
  mergedCodexConfig,
  opencodeProvider,
  piProvider,
  type AgentEndpoint,
} from '@gyblos/node/agent-setup';

const ENDPOINT: AgentEndpoint = {
  origin: 'http://127.0.0.1:4031',
  models: [
    { id: 'qwen3-0.6b', maxOutputTokens: 100 },
    { id: 'gpt-oss-20b', maxOutputTokens: 2000, contextTokens: 131072 },
  ],
};

void test('every tool gets every model with its limits, on the local endpoint', () => {
  const opencode = opencodeProvider(ENDPOINT);
  assert.equal(opencode.options.baseURL, 'http://127.0.0.1:4031/v1');
  assert.deepEqual(opencode.models['gpt-oss-20b']?.limit, {
    context: 131072,
    output: 2000,
  });
  assert.deepEqual(opencode.models['qwen3-0.6b']?.limit, {
    context: 32768,
    output: 100,
  });
  const pi = piProvider(ENDPOINT);
  assert.equal(pi.api, 'openai-completions');
  assert.deepEqual(
    pi.models.map((model) => [model.id, model.maxTokens, model.contextWindow]),
    [
      ['qwen3-0.6b', 100, 32768],
      ['gpt-oss-20b', 2000, 131072],
    ],
  );
  const codex = codexBlock(ENDPOINT);
  assert.match(codex, /wire_api = "responses"/);
  assert.match(codex, /stream_max_retries = 0/);
  assert.match(
    codex,
    /\[profiles\."gyblos"\]\nmodel_provider = "gyblos"\nmodel = "qwen3-0.6b"/,
  );
  assert.match(codex, /\[profiles\."gyblos-gpt-oss-20b"\]/);
  // Tables only, so the block is valid at the end of any config.toml.
  const lines = codex
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));
  assert.match(lines[0]!, /^\[/);
  const claude = claudeCodeEnvironment(ENDPOINT);
  assert.match(claude, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:4031\n/);
  assert.match(claude, /ANTHROPIC_MODEL=qwen3-0\.6b/);
});

void test('a paid endpoint token is referenced by its variable name, never written', () => {
  const paid = { ...ENDPOINT, tokenEnv: 'GYBLOS_API_KEY' };
  assert.equal(opencodeProvider(paid).options.apiKey, '{env:GYBLOS_API_KEY}');
  assert.equal(piProvider(paid).apiKey, '$GYBLOS_API_KEY');
  assert.match(codexBlock(paid), /env_key = "GYBLOS_API_KEY"/);
  assert.match(claudeCodeEnvironment(paid), /AUTH_TOKEN="\$GYBLOS_API_KEY"/);
  assert.doesNotMatch(codexBlock(ENDPOINT), /env_key/);
});

void test('endpoints that are not this machine, bad names and bad variables are refused', () => {
  for (const bad of [
    { ...ENDPOINT, origin: 'https://127.0.0.1:4031' },
    { ...ENDPOINT, origin: 'http://example.com:4031' },
    { ...ENDPOINT, origin: 'http://127.0.0.1:4031/v1' },
    { ...ENDPOINT, models: [] },
    { ...ENDPOINT, models: [{ id: 'a"b', maxOutputTokens: 1 }] },
    { ...ENDPOINT, models: [{ id: 'ok', maxOutputTokens: 0 }] },
    { ...ENDPOINT, tokenEnv: 'X; rm -rf' },
  ])
    assert.throws(
      () => codexBlock(bad),
      { code: 'ENDPOINT' },
      JSON.stringify(bad),
    );
});

void test("merging keeps the user's other providers and choices, and refuses files it cannot read safely", () => {
  const opencode = JSON.parse(
    mergedAgentFile(
      AGENT_TOOLS.OPENCODE,
      ENDPOINT,
      JSON.stringify({
        model: 'anthropic/x',
        provider: { other: { name: 'Other' } },
        theme: 'dark',
      }),
    ),
  );
  assert.equal(opencode.model, 'anthropic/x');
  assert.equal(opencode.theme, 'dark');
  assert.deepEqual(Object.keys(opencode.provider), ['other', 'gyblos']);
  const fresh = JSON.parse(
    mergedAgentFile(AGENT_TOOLS.OPENCODE, ENDPOINT, undefined),
  );
  assert.equal(fresh.model, 'gyblos/qwen3-0.6b');
  const pi = JSON.parse(
    mergedAgentFile(
      AGENT_TOOLS.PI,
      ENDPOINT,
      '{"providers":{"local":{"api":"x"}}}',
    ),
  );
  assert.deepEqual(Object.keys(pi.providers), ['local', 'gyblos']);
  for (const text of ['{ // comment\n}', '[]', 'not json'])
    assert.throws(() => mergedAgentFile(AGENT_TOOLS.PI, ENDPOINT, text), {
      code: 'FILE',
    });
});

void test('the Codex block is added once and replaced in place, never doubled', () => {
  const user = 'model = "o3"\n\n[mcp_servers.x]\ncommand = "x"\n';
  const once = mergedCodexConfig(ENDPOINT, user);
  assert.ok(once.startsWith(user));
  const twice = mergedCodexConfig(
    { ...ENDPOINT, models: [ENDPOINT.models[1]!] },
    once,
  );
  assert.equal(twice.split(CODEX_MARKS.start).length, 2);
  assert.match(twice, /model = "gpt-oss-20b"/);
  assert.doesNotMatch(twice, /qwen3/);
  assert.ok(twice.startsWith(user));
  for (const edited of [
    `${user}${CODEX_MARKS.start}\n`,
    `${user}[model_providers.gyblos]\nname = "mine"\n`,
  ])
    assert.throws(() => mergedCodexConfig(ENDPOINT, edited), { code: 'FILE' });
});

void test('writing a tool file keeps the previous copy beside it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-agent-'));
  const file = join(home, '.pi/agent/models.json');
  await mkdir(join(home, '.pi/agent'), { recursive: true });
  await writeFile(file, '{"providers":{"local":{}}}');
  assert.equal(await writeAgentFile(AGENT_TOOLS.PI, ENDPOINT, home), file);
  assert.equal(
    await readFile(`${file}.before-gyblos`, 'utf8'),
    '{"providers":{"local":{}}}',
  );
  assert.ok(JSON.parse(await readFile(file, 'utf8')).providers.gyblos);
  const codex = await writeAgentFile(AGENT_TOOLS.CODEX, ENDPOINT, home);
  assert.match(await readFile(codex, 'utf8'), /wire_api = "responses"/);
  assert.match(agentText(AGENT_TOOLS.OPENCODE, ENDPOINT), /"gyblos"/);
});
