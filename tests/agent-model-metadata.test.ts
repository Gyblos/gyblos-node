// Synthetic local model metadata and legacy configuration; no real agent profile or network seller is read.
import assert from 'node:assert/strict';
import test from 'node:test';

import { USDC_API_ACTION } from '@gyblos/desktop/usdc-api-model';
import {
  AGENT_SETUP_CODES,
  AGENT_TOOLS,
  codexProfiles,
  mergedCodexConfig,
  mergedCodexProfile,
  opencodeProvider,
  piProvider,
  type AgentEndpoint,
} from '@gyblos/node/agent-setup';

import { desktopAgentFixture } from './support/desktop-agent';

const endpoint: AgentEndpoint = {
  origin: 'http://127.0.0.1:4033',
  models: [{ id: 'synthetic-root', maxOutputTokens: 32768 }],
};

void test('unknown seller context uses conservative shared limits for every generated agent', () => {
  assert.deepEqual(opencodeProvider(endpoint).models['synthetic-root']?.limit, {
    context: 8192,
    output: 4096,
  });
  const pi = piProvider(endpoint).models[0]!;
  assert.equal(pi.contextWindow, 8192);
  assert.equal(pi.maxTokens, 4096);
  for (const profile of codexProfiles(endpoint)) {
    assert.match(profile.text, /model_context_window = 8192\n/);
    assert.match(profile.text, /model_auto_compact_token_limit = 4096\n/);
  }
});

void test('authenticated explicit model context is retained by the desktop agent generator', async (t) => {
  const fixture = await desktopAgentFixture({
    models: async () =>
      Response.json({
        object: 'list',
        data: [
          {
            id: 'synthetic-root',
            max_output_tokens: 4000,
            context_length: 16384,
          },
        ],
      }),
  });
  t.after(() => fixture.close());
  const result = await fixture.run(
    USDC_API_ACTION.PREVIEW_AGENT,
    AGENT_TOOLS.OPENCODE,
  );
  assert.equal(result.error, null);
  const value = JSON.parse(result.setup!.text);
  assert.deepEqual(value.provider.gyblos.models['synthetic-root'].limit, {
    context: 16384,
    output: 4000,
  });
  assert.equal(fixture.generations(), 0);
});

void test('malformed or contradictory explicit context is refused before writing agent settings', async (t) => {
  for (const context of [0, '8192', 32, 10_000_001]) {
    const fixture = await desktopAgentFixture({
      models: async () =>
        Response.json({
          object: 'list',
          data: [
            {
              id: 'synthetic-root',
              max_output_tokens: 32,
              context_length: context,
            },
          ],
        }),
    });
    t.after(() => fixture.close());
    const result = await fixture.run(
      USDC_API_ACTION.WRITE_AGENT,
      AGENT_TOOLS.PI,
    );
    assert.notEqual(result.error, null);
    assert.equal(result.setup, undefined);
    assert.equal(fixture.generations(), 0);
  }
});

const legacyStart = '# >>> gyblos (managed by pnpm buyer:agent codex)';
const legacyProfile = '# gyblos profile (managed by pnpm buyer:agent codex)';
const legacy = `${legacyStart}\n[model_providers.gyblos]\nname = "Gyblos"\nbase_url = "http://127.0.0.1:4031/v1"\nwire_api = "responses"\n# <<< gyblos\n`;

void test('legacy Codex blocks migrate to neutral ownership without changing personal settings', () => {
  const result = mergedCodexConfig(endpoint, `model = "personal"\n\n${legacy}`);
  assert.match(result, /^model = "personal"/);
  assert.match(result, /# >>> gyblos \(managed by Gyblos\)/);
  assert.doesNotMatch(result, /managed by pnpm/);
  assert.equal(mergedCodexConfig(endpoint, result), result);
});

void test('legacy Codex profiles migrate but mixed ownership blocks are refused', () => {
  const current = codexProfiles(endpoint)[0]!.text;
  const previous = `${legacyProfile}\nmodel_provider = "gyblos"\nmodel = "synthetic-root"\nweb_search = "disabled"\n`;
  assert.equal(mergedCodexProfile(current, previous), current);
  assert.doesNotMatch(current, /managed by pnpm/);
  assert.throws(
    () =>
      mergedCodexConfig(
        endpoint,
        legacy.replace(
          legacyStart,
          legacyStart + '\n# >>> gyblos (managed by Gyblos)',
        ),
      ),
    { code: AGENT_SETUP_CODES.FILE },
  );
});
