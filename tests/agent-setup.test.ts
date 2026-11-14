// Connecting coding agents to a local buyer from one source: every served model with its limits for
// OpenCode, pi, Codex CLI and Claude Code; files merged keeping everything but the gyblos provider; a
// managed Codex block replaced in place; a paid token referenced by name only; non-loopback endpoints
// and hand-edited files refused. Temporary homes only; no real configuration is touched.
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as legacy from '@gyblos/buyer/agent-cli';
import {
  AGENT_TOOLS,
  agentFilePath,
  claudeCodeEnvironment,
  CODEX_MARKS,
  codexBlock,
  codexProfiles,
  mergedAgentFile,
  mergedCodexConfig,
  mergedCodexProfile,
  opencodeProvider,
  piProvider,
  type AgentEndpoint,
} from '@gyblos/node/agent-setup';
import { agentText, writeAgentFile } from '@gyblos/node/agent-setup-host';

const ENDPOINT: AgentEndpoint = {
  origin: 'http://127.0.0.1:4031',
  models: [
    { id: 'qwen3-0.6b', maxOutputTokens: 100 },
    { id: 'gpt-oss-20b', maxOutputTokens: 2000, contextTokens: 131072 },
  ],
};

void test('every tool gets every model with its limits, on the local endpoint', () => {
  assert.ok(Object.keys(legacy).includes('agentText'));
  assert.ok(Object.keys(legacy).includes('writeAgentFile'));
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
  // Codex CLI 0.162+ refuses profile tables in config.toml: each profile is its own file.
  assert.doesNotMatch(codex, /profiles/);
  const profiles = codexProfiles(ENDPOINT);
  assert.deepEqual(
    profiles.map((profile) => profile.file),
    [
      'gyblos.config.toml',
      'gyblos-qwen3-0-6b.config.toml',
      'gyblos-gpt-oss-20b.config.toml',
    ],
  );
  assert.match(
    profiles[0]!.text,
    /^# .*\nmodel_provider = "gyblos"\nmodel = "qwen3-0.6b"\nweb_search = "disabled"\n$/,
  );
  assert.match(profiles[2]!.text, /model = "gpt-oss-20b"/);
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
  assert.equal(twice, once);
  assert.ok(twice.startsWith(user));
  for (const edited of [
    `${user}${CODEX_MARKS.start}\n`,
    `${user}[model_providers.gyblos]\nname = "mine"\n`,
  ])
    assert.throws(() => mergedCodexConfig(ENDPOINT, edited), { code: 'FILE' });
});

void test('writing keeps the first copy of the previous file, atomically, and honors where tools look', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-agent-'));
  const file = join(home, '.pi/agent/models.json');
  await mkdir(join(home, '.pi/agent'), { recursive: true });
  await writeFile(file, '{"providers":{"local":{}}}', { mode: 0o600 });
  const first = await writeAgentFile(AGENT_TOOLS.PI, ENDPOINT, home);
  assert.deepEqual(first, { path: file, backup: `${file}.before-gyblos` });
  assert.ok(JSON.parse(await readFile(file, 'utf8')).providers.gyblos);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // A second run keeps the true original, not the first run's output.
  const second = await writeAgentFile(AGENT_TOOLS.PI, ENDPOINT, home);
  assert.equal(second.backup, undefined);
  assert.equal(
    await readFile(`${file}.before-gyblos`, 'utf8'),
    '{"providers":{"local":{}}}',
  );
  assert.deepEqual((await readdir(join(home, '.pi/agent'))).sort(), [
    'models.json',
    'models.json.before-gyblos',
  ]);
  const codexHome = join(home, 'elsewhere');
  const codex = await writeAgentFile(AGENT_TOOLS.CODEX, ENDPOINT, home, {
    CODEX_HOME: codexHome,
  });
  assert.equal(codex.path, join(codexHome, 'config.toml'));
  assert.match(await readFile(codex.path, 'utf8'), /wire_api = "responses"/);
  assert.deepEqual(
    codex.profiles,
    codexProfiles(ENDPOINT).map((profile) => join(codexHome, profile.file)),
  );
  assert.equal(
    await readFile(join(codexHome, 'gyblos.config.toml'), 'utf8'),
    codexProfiles(ENDPOINT)[0]!.text,
  );
  assert.equal(
    (await stat(join(codexHome, 'gyblos.config.toml'))).mode & 0o777,
    0o600,
  );
  assert.equal(
    agentFilePath(AGENT_TOOLS.OPENCODE, home, { XDG_CONFIG_HOME: '/x' }),
    '/x/opencode/opencode.json',
  );
  assert.equal(
    agentFilePath(AGENT_TOOLS.PI, home, { PI_CODING_AGENT_DIR: '/p' }),
    '/p/models.json',
  );
  // An opencode.jsonc beside it holds comments this command would drop: refused.
  await mkdir(join(home, '.config/opencode'), { recursive: true });
  await writeFile(join(home, '.config/opencode/opencode.jsonc'), '{}');
  await assert.rejects(writeAgentFile(AGENT_TOOLS.OPENCODE, ENDPOINT, home), {
    code: 'FILE',
  });
  assert.match(agentText(AGENT_TOOLS.OPENCODE, ENDPOINT), /"gyblos"/);
});

void test('Codex profiles never collide, and gyblos tables outside the block are refused', () => {
  const files = codexProfiles({
    ...ENDPOINT,
    models: [
      { id: 'qwen/qwen3:8b', maxOutputTokens: 10 },
      { id: 'qwen/qwen3-8b', maxOutputTokens: 10 },
      { id: 'gyblos', maxOutputTokens: 10 },
      // One file on macOS and Windows unless numbered apart.
      { id: 'Qwen3', maxOutputTokens: 10 },
      { id: 'qwen3', maxOutputTokens: 10 },
    ],
  }).map((profile) => profile.file);
  assert.equal(
    new Set(files.map((file) => file.toLowerCase())).size,
    files.length,
  );
  assert.equal(files.length, 6);
  for (const user of [
    '[profiles.gyblos]\nmodel = "x"\n',
    '[profiles."gyblos-a"]\nmodel = "x"\n',
    '[model_providers."gyblos"]\nname = "x"\n',
  ])
    assert.throws(() => mergedCodexConfig(ENDPOINT, user), { code: 'FILE' });
});

void test('Claude Code aliases point at served models, and a context must exceed the answer', () => {
  const claude = claudeCodeEnvironment(ENDPOINT);
  for (const alias of ['OPUS', 'SONNET', 'HAIKU'])
    assert.match(
      claude,
      new RegExp(`ANTHROPIC_DEFAULT_${alias}_MODEL=qwen3-0\\.6b`),
    );
  assert.match(claude, /ANTHROPIC_CUSTOM_MODEL_OPTION=gpt-oss-20b/);
  assert.doesNotMatch(claude, /SMALL_FAST/);
  assert.throws(
    () =>
      opencodeProvider({
        ...ENDPOINT,
        models: [{ id: 'm', maxOutputTokens: 4096, contextTokens: 1000 }],
      }),
    { code: 'ENDPOINT' },
  );
});

void test('a block from before Codex CLI 0.162 loses its profile tables, which become files', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-agent-legacy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = join(home, '.codex');
  await mkdir(codexHome);
  const legacy = [
    'model = "o3"',
    '',
    CODEX_MARKS.start,
    codexBlock(ENDPOINT)
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n'),
    '',
    '[profiles."gyblos"]',
    'model_provider = "gyblos"',
    'model = "qwen3-0.6b"',
    'web_search = "disabled"',
    CODEX_MARKS.end,
    '',
  ].join('\n');
  await writeFile(join(codexHome, 'config.toml'), legacy, { mode: 0o600 });
  await writeAgentFile(AGENT_TOOLS.CODEX, ENDPOINT, home);
  const config = await readFile(join(codexHome, 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /profiles/);
  assert.ok(config.startsWith('model = "o3"\n'));
  assert.ok((await readdir(codexHome)).includes('gyblos.config.toml'));
});

void test('a profile file gyblos did not write is refused, and nothing is written', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-agent-profile-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = join(home, '.codex');
  await mkdir(codexHome);
  const mine = 'model = "my-own"\n';
  await writeFile(join(codexHome, 'gyblos-gpt-oss-20b.config.toml'), mine);
  await assert.rejects(writeAgentFile(AGENT_TOOLS.CODEX, ENDPOINT, home), {
    code: 'FILE',
  });
  assert.deepEqual(await readdir(codexHome), [
    'gyblos-gpt-oss-20b.config.toml',
  ]);
  const ours = codexProfiles(ENDPOINT)[0]!.text;
  assert.equal(mergedCodexProfile('new', ours), 'new');
  for (const edited of [mine, `${ours}approval_policy = "never"\n`])
    assert.throws(() => mergedCodexProfile('new', edited), { code: 'FILE' });
});
