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
  NODE_ERROR_CODES,
} from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';
import {
  parseNodeConfig,
  pricePerMtokToAtomicPerMtok,
  readNodeConfigFile,
  type NodeConfigResult,
} from '@gyblos/node/node-config';

import {
  BASE,
  exampleFiles,
  FAKE_SECRET,
  offer,
  VALID_FIXTURES,
} from './support/node-config-fixtures';
import { INVALID_FIXTURES } from './support/node-config-invalid';

function issuesOf(result: NodeConfigResult) {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
}

void test('every example in examples/ is a valid gyblos.toml', () => {
  const examples = exampleFiles();
  assert.deepEqual(
    examples.map((example) => example.name),
    [
      'anthropic-free.toml',
      'anthropic-reseller.toml',
      'free-offer.toml',
      'lm-studio.toml',
      'multi-model.toml',
      'ollama-local.toml',
      'openai-free.toml',
      'openai-reseller.toml',
      'seller-daemon.toml',
      'seller-docker.toml',
    ],
  );
  for (const example of examples) {
    const result = parseNodeConfig(example.toml);
    assert.deepEqual(result.ok ? [] : result.issues, [], example.name);
    // Only the custom-model examples warn that their reasoning levels are unverified.
    assert.deepEqual(
      result.ok ? result.warnings.map((warning) => warning.code) : [],
      ['anthropic-free.toml', 'anthropic-reseller.toml'].includes(example.name)
        ? ['REASONING_UNVERIFIED']
        : [],
      example.name,
    );
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
        model: 'qwen3:30b-a3b-q4_K_M',
        engine:
          '{ kind = "openai", url = "http://host.docker.internal:1234/v1", api_key_env = "LM_KEY", upstream_model = "qwen/qwen3-30b-a3b", context_tokens = 32768 }',
      }),
      offer({
        model: 'qwen3-0.6b',
        extra: 'reasoning = ["off", "high"]',
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
          requested: 'qwen3:30b-a3b-q4_K_M',
        },
        engine: {
          kind: 'openai',
          url: 'http://host.docker.internal:1234/v1',
          apiKeyEnv: 'LM_KEY',
          upstreamModel: 'qwen/qwen3-30b-a3b',
          contextTokens: 32768,
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
        reasoning: ['off', 'high'],
        pricing: {
          kind: 'free',
          dailyTokenCap: 200000,
          perBuyerCap: 5000,
          maxOutputTokens: 4096,
        },
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

void test('prices with trailing fractional zeros are accepted and normalized to the canonical form', () => {
  const cases: [string, string][] = [
    ['0.10', '0.1'],
    ['1.50', '1.5'],
    ['2.0', '2'],
    ['0.1000000', '0.1'],
    ['0.000001', '0.000001'],
    ['9999.999999', '9999.999999'],
    ['0.00', '0'],
    ['12', '12'],
  ];
  for (const [written, canonical] of cases) {
    const result = parseNodeConfig(
      BASE +
        offer({
          pricing: `price = { input_per_mtok = "${written}", output_per_mtok = "1", currency = "USDC" }`,
        }),
    );
    assert.ok(result.ok, `${written}: ${JSON.stringify(result)}`);
    const [entry] = result.config.offers;
    assert.equal(entry?.pricing.kind, 'paid');
    if (entry?.pricing.kind === 'paid')
      assert.equal(entry.pricing.inputPerMtok, canonical, written);
  }
});

void test('USDC per million tokens converts exactly to atomic units per million tokens', () => {
  const cases: [string, bigint][] = [
    ['0.1', 100_000n],
    ['1.5', 1_500_000n],
    ['0.000001', 1n],
    ['0', 0n],
    ['2', 2_000_000n],
    ['0.10', 100_000n],
    ['9999.999999', 9_999_999_999n],
  ];
  for (const [decimal, atomic] of cases)
    assert.equal(pricePerMtokToAtomicPerMtok(decimal), atomic, decimal);
  for (const invalid of ['', '00.1', '1.', '-1', '1e3', '0.0000001', '12345'])
    assert.throws(
      () => pricePerMtokToAtomicPerMtok(invalid),
      (error: unknown) =>
        error instanceof NodeError &&
        error.code === NODE_ERROR_CODES.INVALID_PRICE,
      invalid,
    );
});

void test('examples follow the reasoning levels each model supports and do not publish by default', () => {
  for (const example of exampleFiles()) {
    const result = parseNodeConfig(example.toml);
    assert.ok(result.ok, example.name);
    assert.notEqual(result.config.discovery?.publish, true, example.name);
    for (const entry of result.config.offers) {
      // gpt-oss has low/medium/high effort and no off switch; Qwen3 is on/off (GYB-DOC-028).
      if (entry.model.id.startsWith('gpt-oss'))
        assert.equal(entry.reasoning.includes('off'), false, example.name);
      // The seller daemon's pinned Qwen3 template (also in Docker) implements only off.
      if (entry.model.id.startsWith('qwen3'))
        assert.deepEqual(
          entry.reasoning,
          ['seller-daemon.toml', 'seller-docker.toml'].includes(example.name)
            ? ['off']
            : ['off', 'high'],
          example.name,
        );
    }
  }
});

void test('a free offer may set its longest answer, and an Ollama engine its context', () => {
  const result = parseNodeConfig(
    BASE +
      offer({
        engine:
          '{ kind = "ollama", url = "http://127.0.0.1:11434", context_tokens = 16384 }',
        pricing:
          'free = { daily_token_cap = 200000, per_buyer_cap = 50000, max_output_tokens = 2048 }',
      }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.config.offers[0]?.engine.contextTokens, 16384);
  assert.deepEqual(result.config.offers[0]?.pricing, {
    kind: 'free',
    dailyTokenCap: 200000,
    perBuyerCap: 50000,
    maxOutputTokens: 2048,
  });
  assert.deepEqual(
    issuesOf(
      parseNodeConfig(
        BASE +
          offer({
            pricing:
              'free = { daily_token_cap = 10, per_buyer_cap = 5, max_output_tokens = 0 }',
          }),
      ),
    ),
    [{ code: 'INVALID_VALUE', path: 'offers[0].free.max_output_tokens' }],
  );
});

void test('integer settings come from TOML integers; floats and exponents are refused', () => {
  const result = parseNodeConfig(
    BASE +
      offer({
        pricing:
          'free = { daily_token_cap = 1_000_000_000_000, per_buyer_cap = 0x10 }',
      }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.config.version, 1);
  assert.deepEqual(result.config.offers[0]?.pricing, {
    kind: 'free',
    dailyTokenCap: 1_000_000_000_000,
    perBuyerCap: 16,
    maxOutputTokens: 4096,
  });
  assert.deepEqual(
    issuesOf(parseNodeConfig(BASE.replace('version = 1', 'version = 1e0'))),
    [{ code: 'WRONG_TYPE', path: 'version' }],
  );
  assert.deepEqual(
    issuesOf(
      parseNodeConfig(
        BASE.replace('version = 1', 'version = 99999999999999999999'),
      ),
    ),
    [{ code: 'UNSUPPORTED_VERSION', path: 'version' }],
  );
});

void test('unknown key names that look like pasted tokens are redacted in issue paths', () => {
  const token = 'abc123def456ghi789jkl012mno345';
  const issues = issuesOf(
    parseNodeConfig(
      `version = 1\n[node]\n${token} = "x"\nnetwork = "devnet"\n`,
    ),
  );
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.path]),
    [['UNKNOWN_KEY', 'node.<key>']],
  );
  assert.equal(JSON.stringify(issues).includes(token), false);
  assert.deepEqual(
    issuesOf(
      parseNodeConfig(
        'version = 1\n[node]\nnetwork = "devnet"\nmax_tokens_per_request_2026 = 1\n',
      ),
    ).map((issue) => issue.path),
    ['node.max_tokens_per_request_2026'],
  );
});
