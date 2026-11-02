import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  claudeCodeConfig,
  claudeCodePowerShellConfig,
  codexConfig,
  opencodeConfig,
  parsePaypalAgentResult,
  PAYPAL_AGENT_ACTION,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentStatusUnavailable,
  piConfig,
  piSettings,
  retainPaypalAgentStatus,
} from '@gyblos/desktop/paypal-agent-model';

void test('OpenCode configuration uses an environment variable instead of embedding the key', () => {
  const config = opencodeConfig({
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-secret-key',
    model: 'synthetic-model',
  });
  assert.match(config, /\{env:GYBLOS_API_KEY\}/);
  assert.match(config, /synthetic-model/);
  assert.doesNotMatch(config, /synthetic-secret-key/);
  const parsed: unknown = JSON.parse(config);
  assert.ok(parsed && typeof parsed === 'object' && 'provider' in parsed);
  assert.ok('model' in parsed);
  assert.equal(parsed.model, 'gyblos/synthetic-model');
  assert.ok(
    'agent' in parsed &&
      parsed.agent &&
      typeof parsed.agent === 'object' &&
      'title' in parsed.agent,
  );
  assert.deepEqual(parsed.agent.title, { disable: true });
  assert.ok(
    parsed.provider &&
      typeof parsed.provider === 'object' &&
      'gyblos' in parsed.provider,
  );
  assert.ok(
    parsed.provider.gyblos &&
      typeof parsed.provider.gyblos === 'object' &&
      'models' in parsed.provider.gyblos,
  );
  assert.ok(
    parsed.provider.gyblos.models &&
      typeof parsed.provider.gyblos.models === 'object' &&
      'synthetic-model' in parsed.provider.gyblos.models,
  );
  assert.deepEqual(parsed.provider.gyblos.models['synthetic-model'], {
    name: 'synthetic-model',
    tool_call: true,
    limit: { context: 8192, output: 512 },
  });
});

void test('Pi settings disable automatic extra calls for the sandbox session', () => {
  assert.deepEqual(JSON.parse(piSettings()), {
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
    cacheWarming: 'off',
  });
});

void test('Pi configuration connects to Gyblos without embedding its temporary key', () => {
  const config = piConfig({
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-secret-key',
    model: 'synthetic-model',
  });
  assert.doesNotMatch(config, /synthetic-secret-key/);
  const parsed: unknown = JSON.parse(config);
  assert.ok(parsed && typeof parsed === 'object' && 'providers' in parsed);
  assert.ok(parsed.providers && typeof parsed.providers === 'object');
  assert.ok('gyblos' in parsed.providers);
  const provider = parsed.providers.gyblos;
  assert.ok(provider && typeof provider === 'object');
  assert.ok('baseUrl' in provider && 'api' in provider && 'apiKey' in provider);
  assert.equal(provider.baseUrl, 'http://127.0.0.1:12345/v1');
  assert.equal(provider.api, 'openai-completions');
  assert.equal(provider.apiKey, '$GYBLOS_API_KEY');
  assert.ok('models' in provider && Array.isArray(provider.models));
  assert.equal(provider.models[0]?.id, 'synthetic-model');
  assert.equal(provider.models[0]?.maxTokens, 512);
  assert.equal(provider.models[0]?.contextWindow, 8192);
  assert.equal(provider.models[0]?.reasoning, false);
  assert.deepEqual(provider.models[0]?.input, ['text']);
  assert.ok(provider.models[0]?.compat);
  assert.equal(provider.models[0].compat.supportsStore, false);
  assert.equal(provider.models[0].compat.supportsDeveloperRole, false);
  assert.equal(provider.models[0].compat.supportsStrictMode, false);
});

void test('Codex configuration uses Responses without embedding credentials or automatic retries', () => {
  const config = codexConfig({
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-secret-key',
    model: 'synthetic-model',
  });
  assert.doesNotMatch(config, /synthetic-secret-key/);
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /env_key = "GYBLOS_API_KEY"/);
  assert.match(config, /request_max_retries = 0/);
  assert.match(config, /stream_max_retries = 0/);
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /multi_agent = false/);
  assert.match(config, /view_image = false/);
  assert.match(config, /http:\/\/127\.0\.0\.1:12345\/v1/);
});

void test('Claude Code configuration uses a local root URL without embedding credentials', () => {
  const config = claudeCodeConfig({
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-secret-key',
    model: 'synthetic-model',
  });
  assert.doesNotMatch(config, /synthetic-secret-key/);
  assert.match(config, /ANTHROPIC_BASE_URL='http:\/\/127\.0\.0\.1:12345'/);
  assert.match(config, /ANTHROPIC_AUTH_TOKEN="\$GYBLOS_API_KEY"/);
  assert.match(config, /ANTHROPIC_API_KEY="\$GYBLOS_API_KEY"/);
  assert.match(config, /CLAUDE_CODE_MAX_OUTPUT_TOKENS=512/);
  assert.match(config, /CLAUDE_CODE_MAX_CONTEXT_TOKENS=8192/);
  assert.match(config, /CLAUDE_CODE_EFFORT_LEVEL=auto/);
});

void test('Claude Code PowerShell configuration safely sets the local gateway without embedding the key', () => {
  const config = claudeCodePowerShellConfig({
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-secret-key',
    model: "synthetic'model",
  });
  assert.doesNotMatch(config, /synthetic-secret-key/);
  assert.match(config, /\$env:ANTHROPIC_BASE_URL = 'http:\/\/127\.0\.0\.1:12345'/);
  assert.match(config, /\$env:ANTHROPIC_AUTH_TOKEN = \$env:GYBLOS_API_KEY/);
  assert.match(config, /\$env:ANTHROPIC_API_KEY = \$env:GYBLOS_API_KEY/);
  assert.match(config, /\$env:ANTHROPIC_MODEL = 'synthetic''model'/);
  assert.match(config, /\$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS = '512'/);
  assert.match(config, /\$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = '8192'/);
});

void test('a confirmed disconnect clears an older stalled status warning', () => {
  const disconnected = { connection: null, error: null };
  assert.equal(
    paypalAgentStatusUnavailable(
      PAYPAL_AGENT_ACTION.DISCONNECT,
      disconnected,
      true,
    ),
    false,
  );
  assert.equal(
    paypalAgentStatusUnavailable(
      PAYPAL_AGENT_ACTION.CONNECT,
      disconnected,
      true,
    ),
    true,
  );
  assert.equal(
    paypalAgentStatusUnavailable(
      PAYPAL_AGENT_ACTION.DISCONNECT,
      undefined,
      true,
    ),
    true,
  );
});

void test('a failed status check preserves an existing connection until status is known', () => {
  const connection = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'a'.repeat(43),
    model: 'synthetic-model',
    spentCents: 20,
    limitCents: 100,
    usageUncertain: false,
    disconnecting: false,
    usageState: PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
  };
  const previous = { connection, error: null };
  const unknown = retainPaypalAgentStatus(previous, undefined);
  assert.deepEqual(unknown, { result: previous, unavailable: true });
  const recovered = retainPaypalAgentStatus(previous, {
    connection: null,
    error: null,
  });
  assert.deepEqual(recovered, {
    result: { connection: null, error: null },
    unavailable: false,
  });
});

void test('IPC result rejects external connection URLs and malformed keys', () => {
  const connection = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'a'.repeat(43),
    model: 'synthetic-model',
    spentCents: 0,
    limitCents: 100,
    usageUncertain: false,
    disconnecting: false,
    usageState: PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
  };
  assert.deepEqual(
    parsePaypalAgentResult({ connection, error: null }).connection,
    connection,
  );
  assert.equal(
    parsePaypalAgentResult({
      connection: { ...connection, url: 'https://external.invalid/v1' },
      error: null,
    }).connection,
    null,
  );
  assert.equal(
    parsePaypalAgentResult({
      connection: { ...connection, key: 'short' },
      error: null,
    }).connection,
    null,
  );
});
