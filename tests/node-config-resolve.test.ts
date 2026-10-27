// Owns the precedence contract (flag > GYBLOS_* env > gyblos.toml > default) and proves that resolving
// from the environment alone reproduces today's readers. Offline; env values are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCOVERY_INDEX_URL, homeLayout } from '@gyblos/config';
import { parseNodeConfig, type NodeConfig } from '@gyblos/node/node-config';
import {
  resolveNodeConfig,
  type ResolvedNodeConfig,
} from '@gyblos/node/node-config-resolve';
import { sellerPublicationConfig } from '@gyblos/node/publisher-config';

import { BASE, FAKE_SECRET, offer } from './support/node-config-fixtures';

function fileConfig(toml: string): NodeConfig {
  const result = parseNodeConfig(toml);
  assert.ok(result.ok, JSON.stringify(result));
  return result.config;
}

function resolved(result: ResolvedNodeConfig) {
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

function originOf(result: ResolvedNodeConfig, setting: string) {
  return resolved(result).origins.find((origin) => origin.setting === setting);
}

void test('with no file, flags or variables the settings equal today defaults', () => {
  const result = resolved(resolveNodeConfig({ env: {} }));
  assert.deepEqual(result.settings, {
    network: 'devnet',
    home: '.local/gyblos',
    rpcUrl: 'https://api.devnet.solana.com',
    payoutWallet: undefined,
    relayUrls: ['https://na1.relay.gyblos.com/'],
    relayTokenEnv: 'GYBLOS_RELAY_TOKEN',
    relayOnly: false,
    irohBind: undefined,
    irohExternalAddress: undefined,
    buyerRelayOnly: false,
    discoveryPublish: false,
    discoveryUrl: 'https://discovery.gyblos.com/v1',
    offers: [],
  });
  assert.ok(result.origins.every((origin) => origin.source === 'default'));
  assert.deepEqual(result.warnings, []);
});

void test('environment-only resolution reproduces each current reader', () => {
  const environment = {
    GYBLOS_HOME: '/srv/gyblos',
    GYBLOS_RPC_URL: 'http://rpc.internal.example:8899',
    GYBLOS_RELAYS:
      'https://na1.relay.gyblos.com, https://na2.relay.gyblos.com/,https://na1.relay.gyblos.com',
    GYBLOS_RELAY_ONLY: '1',
    GYBLOS_IROH_BIND: '0.0.0.0:7843',
    GYBLOS_BUYER_RELAY_ONLY: '1',
    GYBLOS_DISCOVERY_PUBLISH: '1',
    GYBLOS_DISCOVERY_URL: 'http://127.0.0.1:8787/v1',
  };
  const { settings, origins } = resolved(
    resolveNodeConfig({ env: environment }),
  );
  assert.equal(settings.home, homeLayout(environment).root);
  assert.equal(settings.rpcUrl, 'http://rpc.internal.example:8899');
  assert.deepEqual(settings.relayUrls, [
    'https://na1.relay.gyblos.com/',
    'https://na2.relay.gyblos.com/',
  ]);
  assert.equal(settings.relayOnly, true);
  assert.equal(settings.irohBind, '0.0.0.0:7843');
  assert.equal(settings.buyerRelayOnly, true);
  assert.equal(settings.discoveryPublish, true);
  assert.deepEqual(
    { baseUrl: settings.discoveryUrl },
    sellerPublicationConfig(environment),
  );
  assert.deepEqual(
    origins
      .filter((origin) => origin.source === 'env')
      .map((origin) => [origin.setting, origin.name]),
    [
      ['home', 'GYBLOS_HOME'],
      ['rpcUrl', 'GYBLOS_RPC_URL'],
      ['relayUrls', 'GYBLOS_RELAYS'],
      ['relayOnly', 'GYBLOS_RELAY_ONLY'],
      ['irohBind', 'GYBLOS_IROH_BIND'],
      ['buyerRelayOnly', 'GYBLOS_BUYER_RELAY_ONLY'],
      ['discoveryPublish', 'GYBLOS_DISCOVERY_PUBLISH'],
      ['discoveryUrl', 'GYBLOS_DISCOVERY_URL'],
    ],
  );
});

void test('today edge semantics: empty home and empty Iroh addresses fall back; publish 0 is off', () => {
  const environment = {
    GYBLOS_HOME: '',
    GYBLOS_IROH_BIND: '',
    GYBLOS_IROH_EXTERNAL_ADDR: '',
    GYBLOS_DISCOVERY_PUBLISH: '0',
  };
  const { settings } = resolved(resolveNodeConfig({ env: environment }));
  assert.equal(settings.home, homeLayout(environment).root);
  assert.equal(settings.irohBind, undefined);
  assert.equal(settings.irohExternalAddress, undefined);
  assert.equal(settings.discoveryPublish, false);
  assert.equal(sellerPublicationConfig(environment), undefined);
});

void test('a switch other than 1 is off, as today, and raises a warning naming only the variable', () => {
  const result = resolved(
    resolveNodeConfig({
      env: { GYBLOS_RELAY_ONLY: 'true', GYBLOS_BUYER_RELAY_ONLY: '' },
    }),
  );
  assert.equal(result.settings.relayOnly, false);
  assert.equal(result.settings.buyerRelayOnly, false);
  assert.deepEqual(result.warnings, [
    { code: 'ENV_SWITCH_NOT_STRICT', path: 'env.GYBLOS_RELAY_ONLY' },
    { code: 'ENV_SWITCH_NOT_STRICT', path: 'env.GYBLOS_BUYER_RELAY_ONLY' },
  ]);
});

void test('invalid environment values become issues that name the variable, never its value', () => {
  const result = resolveNodeConfig({
    env: {
      GYBLOS_RPC_URL: `ftp://${FAKE_SECRET}.example`,
      GYBLOS_RELAYS: `https://${FAKE_SECRET}.example/path`,
      GYBLOS_DISCOVERY_PUBLISH: 'yes',
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.issues, [
    { code: 'INVALID_URL', path: 'env.GYBLOS_RPC_URL' },
    { code: 'INVALID_URL', path: 'env.GYBLOS_RELAYS' },
    { code: 'INVALID_VALUE', path: 'env.GYBLOS_DISCOVERY_PUBLISH' },
  ]);
  assert.equal(JSON.stringify(result).includes(FAKE_SECRET), false);
  assert.throws(() =>
    sellerPublicationConfig({ GYBLOS_DISCOVERY_PUBLISH: 'yes' }),
  );
});

void test('an invalid discovery URL matters only when publishing, as today', () => {
  const quiet = { GYBLOS_DISCOVERY_URL: 'http://index.example.com/v1' };
  assert.equal(resolveNodeConfig({ env: quiet }).ok, true);
  const publishing = { ...quiet, GYBLOS_DISCOVERY_PUBLISH: '1' };
  assert.throws(() => sellerPublicationConfig(publishing));
  const result = resolveNodeConfig({ env: publishing });
  assert.deepEqual(result.ok ? [] : result.issues, [
    { code: 'INSECURE_URL', path: 'env.GYBLOS_DISCOVERY_URL' },
  ]);
});

void test('precedence is flag over env over file over default, with explanations', () => {
  const file = fileConfig(
    [
      'version = 1',
      '[node]',
      'network = "devnet"',
      'data_dir = "/from-file"',
      'rpc_url = "https://rpc.file.example"',
      '[transport]',
      'relay_only = true',
      'bind = "0.0.0.0:1111"',
      '[discovery]',
      'publish = true',
      'url = "https://index.file.example/v1"',
      '',
    ].join('\n'),
  );
  const env = {
    GYBLOS_HOME: '/from-env',
    GYBLOS_RPC_URL: 'https://rpc.env.example',
    GYBLOS_IROH_BIND: '0.0.0.0:2222',
  };
  const flags = { home: '/from-flag' };
  const all = resolveNodeConfig({ file, env, flags });
  assert.equal(resolved(all).settings.home, '/from-flag');
  assert.deepEqual(originOf(all, 'home'), {
    setting: 'home',
    source: 'flag',
    name: '--home',
  });
  assert.deepEqual(originOf(all, 'rpcUrl'), {
    setting: 'rpcUrl',
    source: 'env',
    name: 'GYBLOS_RPC_URL',
  });
  assert.equal(resolved(all).settings.irohBind, '0.0.0.0:2222');
  assert.deepEqual(originOf(all, 'relayOnly'), {
    setting: 'relayOnly',
    source: 'file',
    name: 'transport.relay_only',
  });
  assert.deepEqual(originOf(all, 'discoveryUrl'), {
    setting: 'discoveryUrl',
    source: 'file',
    name: 'discovery.url',
  });
  assert.deepEqual(originOf(all, 'relayUrls'), {
    setting: 'relayUrls',
    source: 'default',
    name: 'default',
  });
  const withoutFlag = resolved(resolveNodeConfig({ file, env }));
  assert.equal(withoutFlag.settings.home, '/from-env');
  const fileOnly = resolved(resolveNodeConfig({ file, env: {} }));
  assert.equal(fileOnly.settings.home, '/from-file');
  assert.equal(fileOnly.settings.rpcUrl, 'https://rpc.file.example');
  assert.equal(fileOnly.settings.discoveryPublish, true);
  assert.equal(fileOnly.settings.discoveryUrl, 'https://index.file.example/v1');
  assert.equal(
    resolved(
      resolveNodeConfig({ file, env: { GYBLOS_DISCOVERY_PUBLISH: '0' } }),
    ).settings.discoveryPublish,
    false,
  );
  assert.equal(
    resolved(resolveNodeConfig({ file, env: {}, flags: { relayOnly: false } }))
      .settings.relayOnly,
    false,
  );
});

void test('every setting has exactly one origin', () => {
  const result = resolved(resolveNodeConfig({ env: {} }));
  assert.deepEqual(
    result.origins.map((origin) => origin.setting).sort(),
    Object.keys(result.settings).sort(),
  );
});

void test('secrets are reported by environment name and presence only', () => {
  const file = fileConfig(
    BASE.replace(
      '[node]',
      '[relays]\nrelay_token_env = "MY_RELAY_TOKEN"\n[node]',
    ) +
      offer({
        engine:
          '{ kind = "openai", url = "https://api.example.com/v1", api_key_env = "UPSTREAM_API_KEY" }',
      }),
  );
  const result = resolved(
    resolveNodeConfig({ file, env: { MY_RELAY_TOKEN: FAKE_SECRET } }),
  );
  assert.deepEqual(result.secrets, [
    { path: 'relays.relay_token_env', env: 'MY_RELAY_TOKEN', present: true },
    {
      path: 'offers[0].engine.api_key_env',
      env: 'UPSTREAM_API_KEY',
      present: false,
    },
  ]);
  assert.equal(JSON.stringify(result).includes(FAKE_SECRET), false);
});

void test('relay-only with an external address is refused wherever each value comes from', () => {
  const result = resolveNodeConfig({
    env: {
      GYBLOS_RELAY_ONLY: '1',
      GYBLOS_IROH_EXTERNAL_ADDR: '203.0.113.7:7843',
    },
  });
  assert.deepEqual(result.ok ? [] : result.issues, [
    { code: 'RELAY_ONLY_CONFLICT', path: 'env.GYBLOS_IROH_EXTERNAL_ADDR' },
  ]);
});

void test('flag values are validated like file values', () => {
  const result = resolveNodeConfig({
    env: {},
    flags: { rpcUrl: 'http://rpc.example.com', discoveryUrl: 'not a url' },
  });
  assert.deepEqual(result.ok ? [] : result.issues, [
    { code: 'INSECURE_URL', path: 'flag.--rpc-url' },
    { code: 'INVALID_URL', path: 'flag.--discovery-url' },
  ]);
  assert.equal(DISCOVERY_INDEX_URL, 'https://discovery.gyblos.com/v1');
});
