// Owns the gyblos.toml validator contract: examples parse, every invalid case maps to one static code and
// path, inline secrets are refused and no input value is echoed. Offline; synthetic inputs only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_LIMITS,
} from '@gyblos/node/constants';
import {
  parseNodeConfig,
  readNodeConfigFile,
  type NodeConfigResult,
} from '@gyblos/node/node-config';

import {
  BASE,
  exampleFiles,
  FAKE_SECRET,
  offer,
  VALID_FIXTURES,
} from './support/node-config-fixtures.js';
import { INVALID_FIXTURES } from './support/node-config-invalid.js';

function issuesOf(result: NodeConfigResult) {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
}

void test('every example in examples/ is a valid gyblos.toml', () => {
  const examples = exampleFiles();
  assert.deepEqual(
    examples.map((example) => example.name),
    [
      'anthropic-reseller.toml',
      'free-offer.toml',
      'lm-studio.toml',
      'multi-model.toml',
      'ollama-local.toml',
      'openai-reseller.toml',
    ],
  );
  for (const example of examples) {
    const result = parseNodeConfig(example.toml);
    assert.deepEqual(result.ok ? [] : result.issues, [], example.name);
  }
});

void test('examples use the GYB-DOC-026 catalog models and show reasoning levels', () => {
  const models = new Set<string>();
  const levels = new Set<string>();
  for (const example of exampleFiles()) {
    const result = parseNodeConfig(example.toml);
    assert.ok(result.ok);
    for (const entry of result.config.offers) {
      if (entry.model.kind === 'catalog') models.add(entry.model.id);
      for (const level of entry.reasoning) levels.add(level);
    }
  }
  for (const model of ['gpt-oss-20b', 'qwen3-30b-a3b', 'qwen3-0.6b'])
    assert.ok(models.has(model), model);
  assert.ok(levels.size > 1);
});

void test('valid fixtures parse without issues', () => {
  for (const fixture of VALID_FIXTURES) {
    const result = parseNodeConfig(fixture.toml);
    assert.deepEqual(result.ok ? [] : result.issues, [], fixture.name);
  }
});

void test('every invalid fixture maps to its static code and path', () => {
  for (const fixture of INVALID_FIXTURES) {
    const issues = issuesOf(parseNodeConfig(fixture.toml));
    assert.ok(
      issues.some(
        (issue) => issue.code === fixture.code && issue.path === fixture.path,
      ),
      `${fixture.name}: ${JSON.stringify(issues)}`,
    );
    for (const issue of issues)
      assert.ok(
        Object.values(NODE_CONFIG_ISSUE_CODES).includes(issue.code),
        fixture.name,
      );
  }
});

void test('issues never echo input values, including fake secrets', () => {
  for (const fixture of INVALID_FIXTURES) {
    const serialized = JSON.stringify(parseNodeConfig(fixture.toml));
    assert.equal(serialized.includes(FAKE_SECRET), false, fixture.name);
    assert.equal(serialized.includes('FAKE0SECRET'), false, fixture.name);
  }
});

void test('a TOML syntax error reports only a line and column', () => {
  const issues = issuesOf(
    parseNodeConfig(`${BASE}api_key = "${FAKE_SECRET}\n`),
  );
  assert.equal(issues.length, 1);
  const [issue] = issues;
  assert.equal(issue?.code, NODE_CONFIG_ISSUE_CODES.TOML_SYNTAX);
  assert.equal(typeof issue?.line, 'number');
  assert.equal(typeof issue?.column, 'number');
  assert.deepEqual(Object.keys(issue ?? {}).sort(), [
    'code',
    'column',
    'line',
    'path',
  ]);
});

void test('several problems are all reported, in document order', () => {
  const issues = issuesOf(
    parseNodeConfig(
      `version = 2\n[node]\nnetwork = "mainnet"\ntoken = "${FAKE_SECRET}"\n`,
    ),
  );
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.path]),
    [
      ['UNSUPPORTED_VERSION', 'version'],
      ['MAINNET_UNSUPPORTED', 'node.network'],
      ['INLINE_SECRET', 'node.token'],
    ],
  );
});

void test('secret-like unknown keys are refused as inline secrets, ordinary ones as unknown', () => {
  const cases: [string, string, string][] = [
    [`[node]\napi_key = "x"`, 'INLINE_SECRET', 'node.api_key'],
    [`[node]\nOPENAI_API_KEY = "x"`, 'INLINE_SECRET', 'node.OPENAI_API_KEY'],
    [`[node]\nprivate_key = "x"`, 'INLINE_SECRET', 'node.private_key'],
    [`[node]\nsecret = "x"`, 'INLINE_SECRET', 'node.secret'],
    [`[node]\ncolour = "x"`, 'UNKNOWN_KEY', 'node.colour'],
    [`[node]\ntokenizer = "x"`, 'UNKNOWN_KEY', 'node.tokenizer'],
    [
      `[node]\napi_key_env = "OPENAI_API_KEY"`,
      'UNKNOWN_KEY',
      'node.api_key_env',
    ],
    [`[node]\n"we!rd key" = "x"`, 'UNKNOWN_KEY', 'node.<key>'],
  ];
  for (const [snippet, code, path] of cases) {
    const toml = `version = 1\n${snippet}\nnetwork = "devnet"\n`;
    assert.deepEqual(
      issuesOf(parseNodeConfig(toml)).map((issue) => [issue.code, issue.path]),
      [[code, path]],
      snippet,
    );
  }
});

void test('the typed config maps snake_case keys, resolves aliases and applies offer defaults', () => {
  const result = parseNodeConfig(
    [
      'version = 1',
      '[node]',
      'network = "devnet"',
      'data_dir = "/data"',
      '[relays]',
      'urls = ["https://na1.relay.gyblos.com"]',
      'relay_token_env = "MY_RELAY_TOKEN"',
      '[transport]',
      'relay_only = true',
      offer({
        model: 'qwen3:30b-a3b',
        engine:
          '{ kind = "openai", url = "http://host.docker.internal:1234/v1", api_key_env = "LM_KEY", upstream_model = "qwen/qwen3-30b-a3b" }',
      }),
      offer({
        model: 'qwen3-0.6b',
        extra: 'reasoning = ["off", "low"]',
        pricing: 'free = { daily_token_cap = 200000, per_buyer_cap = 5000 }',
      }),
    ].join('\n'),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.config, {
    version: 1,
    node: { network: 'devnet', dataDir: '/data' },
    relays: {
      urls: ['https://na1.relay.gyblos.com/'],
      relayTokenEnv: 'MY_RELAY_TOKEN',
    },
    transport: { relayOnly: true },
    offers: [
      {
        model: {
          kind: 'catalog',
          id: 'qwen3-30b-a3b',
          requested: 'qwen3:30b-a3b',
        },
        engine: {
          kind: 'openai',
          url: 'http://host.docker.internal:1234/v1',
          apiKeyEnv: 'LM_KEY',
          upstreamModel: 'qwen/qwen3-30b-a3b',
        },
        reasoning: ['off'],
        pricing: {
          kind: 'paid',
          inputPerMtok: '0.1',
          outputPerMtok: '0.4',
          currency: 'USDC',
        },
      },
      {
        model: { kind: 'catalog', id: 'qwen3-0.6b', requested: 'qwen3-0.6b' },
        engine: { kind: 'ollama', url: 'http://127.0.0.1:11434' },
        reasoning: ['off', 'low'],
        pricing: { kind: 'free', dailyTokenCap: 200000, perBuyerCap: 5000 },
      },
    ],
  });
});

void test('loopback and Docker host engines may use http; IPv6 loopback included', () => {
  for (const url of [
    'http://127.0.0.1:11434',
    'http://localhost:1234/v1',
    'http://[::1]:11434',
    'http://host.docker.internal:11434',
    'https://api.example.com/v1',
  ]) {
    const toml =
      BASE + offer({ engine: `{ kind = "ollama", url = "${url}" }` });
    const result = parseNodeConfig(toml);
    assert.deepEqual(result.ok ? [] : result.issues, [], url);
  }
});

void test('readNodeConfigFile maps missing, oversized and valid files to static results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-config-'));
  try {
    const missing = await readNodeConfigFile(join(directory, 'none.toml'));
    assert.deepEqual(issuesOf(missing), [
      { code: NODE_CONFIG_ISSUE_CODES.FILE_NOT_FOUND, path: '' },
    ]);
    const large = join(directory, 'large.toml');
    await writeFile(
      large,
      `${BASE}#${'x'.repeat(NODE_CONFIG_LIMITS.fileBytes)}\n`,
    );
    assert.deepEqual(issuesOf(await readNodeConfigFile(large)), [
      { code: NODE_CONFIG_ISSUE_CODES.FILE_TOO_LARGE, path: '' },
    ]);
    const unreadable = await readNodeConfigFile(directory);
    assert.deepEqual(issuesOf(unreadable), [
      { code: NODE_CONFIG_ISSUE_CODES.FILE_UNREADABLE, path: '' },
    ]);
    const valid = join(directory, 'gyblos.toml');
    await writeFile(valid, BASE);
    assert.equal((await readNodeConfigFile(valid)).ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('unsafe keys and deep nesting are syntax errors, not prototype writes', () => {
  for (const toml of [
    `${BASE}[__proto__]\npolluted = true\n`,
    `${BASE}x = [[[[[[[[[[1]]]]]]]]]]\n`,
  ]) {
    const issues = issuesOf(parseNodeConfig(toml));
    assert.equal(issues[0]?.code, NODE_CONFIG_ISSUE_CODES.TOML_SYNTAX, toml);
  }
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
});
