// Synthetic gyblos.toml fixtures shared by the validator, schema and CLI suites; test data only.
// Secret-looking values are fake markers so tests can assert they never reach output.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
export const EXAMPLES_DIRECTORY = join(REPOSITORY_ROOT, 'examples');
export const SCHEMA_PATH = join(
  REPOSITORY_ROOT,
  'packages/node/schemas/gyblos.schema.json',
);

// A fake secret marker: if it ever appears in output, a secret leaked.
export const FAKE_SECRET = 'sk-FAKE0SECRET0MARKER0DO0NOT0ECHO';

export const SYNTHETIC_ADDRESS = '11111111111111111111111111111112';

export const BASE = 'version = 1\n[node]\nnetwork = "devnet"\n';
const ENGINE = '{ kind = "ollama", url = "http://127.0.0.1:11434" }';
const PRICE =
  '{ input_per_mtok = "0.1", output_per_mtok = "0.4", currency = "USDC" }';

export function offer(fields: {
  model?: string;
  extra?: string;
  engine?: string;
  pricing?: string;
}) {
  return [
    '[[offers]]',
    `model = "${fields.model ?? 'gpt-oss-20b'}"`,
    `engine = ${fields.engine ?? ENGINE}`,
    fields.pricing ?? `price = ${PRICE}`,
    fields.extra ?? '',
    '',
  ].join('\n');
}

export interface InvalidConfigFixture {
  name: string;
  toml: string;
  code: string;
  path: string;
  // The JSON Schema cannot express this rule (cross-field or normalized comparison).
  schemaAccepts?: true;
}

const price = (input: string, output: string, currency = 'USDC') =>
  `price = { input_per_mtok = ${input}, output_per_mtok = ${output}, currency = "${currency}" }`;

export const INVALID_FIXTURES: readonly InvalidConfigFixture[] = [
  {
    name: 'missing version',
    toml: '[node]\nnetwork = "devnet"\n',
    code: 'MISSING_KEY',
    path: 'version',
  },
  {
    name: 'future version',
    toml: BASE.replace('version = 1', 'version = 2'),
    code: 'UNSUPPORTED_VERSION',
    path: 'version',
  },
  {
    name: 'version as string',
    toml: BASE.replace('version = 1', 'version = "1"'),
    code: 'WRONG_TYPE',
    path: 'version',
  },
  {
    name: 'unknown top-level key',
    toml: `colour = "blue"\n${BASE}`,
    code: 'UNKNOWN_KEY',
    path: 'colour',
  },
  {
    name: 'missing node table',
    toml: 'version = 1\n',
    code: 'MISSING_KEY',
    path: 'node',
  },
  {
    name: 'mainnet',
    toml: BASE.replace('"devnet"', '"mainnet"'),
    code: 'MAINNET_UNSUPPORTED',
    path: 'node.network',
  },
  {
    name: 'unknown network',
    toml: BASE.replace('"devnet"', '"testnet"'),
    code: 'INVALID_VALUE',
    path: 'node.network',
  },
  {
    name: 'payout wallet not an address',
    toml: `${BASE}payout_wallet = "not-an-address"\n`,
    code: 'INVALID_ADDRESS',
    path: 'node.payout_wallet',
  },
  {
    name: 'empty data dir',
    toml: `${BASE}data_dir = ""\n`,
    code: 'INVALID_VALUE',
    path: 'node.data_dir',
  },
  {
    name: 'rpc url with credentials in the query',
    toml: `${BASE}rpc_url = "https://rpc.example.com/?api-key=${FAKE_SECRET}"\n`,
    code: 'INLINE_SECRET',
    path: 'node.rpc_url',
  },
  {
    name: 'rpc url over plain http to a remote host',
    toml: `${BASE}rpc_url = "http://rpc.example.com"\n`,
    code: 'INSECURE_URL',
    path: 'node.rpc_url',
  },
  {
    name: 'inline password in node',
    toml: `${BASE}password = "${FAKE_SECRET}"\n`,
    code: 'INLINE_SECRET',
    path: 'node.password',
  },
  {
    name: 'relay over plain http',
    toml: `${BASE}[relays]\nurls = ["http://relay.example.com"]\n`,
    code: 'INSECURE_URL',
    path: 'relays.urls[0]',
  },
  {
    name: 'relay with a path',
    toml: `${BASE}[relays]\nurls = ["https://relay.example.com/path"]\n`,
    code: 'INVALID_URL',
    path: 'relays.urls[0]',
  },
  {
    name: 'empty relay list',
    toml: `${BASE}[relays]\nurls = []\n`,
    code: 'INVALID_VALUE',
    path: 'relays.urls',
  },
  {
    name: 'relay listed twice after normalization',
    toml: `${BASE}[relays]\nurls = ["https://relay.example.com", "https://relay.example.com/"]\n`,
    code: 'DUPLICATE_VALUE',
    path: 'relays.urls[1]',
    schemaAccepts: true,
  },
  {
    name: 'inline relay token',
    toml: `${BASE}[relays]\nrelay_token = "${FAKE_SECRET}"\n`,
    code: 'INLINE_SECRET',
    path: 'relays.relay_token',
  },
  {
    name: 'relay token env name in lowercase',
    toml: `${BASE}[relays]\nrelay_token_env = "gyblos_token"\n`,
    code: 'INVALID_ENV_NAME',
    path: 'relays.relay_token_env',
  },
  {
    name: 'relay token pasted into the env name',
    toml: `${BASE}[relays]\nrelay_token_env = "${FAKE_SECRET}"\n`,
    code: 'INLINE_SECRET',
    path: 'relays.relay_token_env',
  },
  {
    name: 'discovery over plain http to a remote host',
    toml: `${BASE}[discovery]\npublish = true\nurl = "http://index.example.com/v1"\n`,
    code: 'INSECURE_URL',
    path: 'discovery.url',
  },
  {
    name: 'discovery publish as a string',
    toml: `${BASE}[discovery]\npublish = "yes"\n`,
    code: 'WRONG_TYPE',
    path: 'discovery.publish',
  },
  {
    name: 'relay-only with an external address',
    toml: `${BASE}[transport]\nrelay_only = true\nexternal_addr = "203.0.113.7:7843"\n`,
    code: 'RELAY_ONLY_CONFLICT',
    path: 'transport.external_addr',
  },
  {
    name: 'bind address that is not ip:port',
    toml: `${BASE}[transport]\nbind = "nonsense"\n`,
    code: 'INVALID_VALUE',
    path: 'transport.bind',
  },
  {
    name: 'buyer relay-only as a string',
    toml: `${BASE}[buyer]\nrelay_only = "1"\n`,
    code: 'WRONG_TYPE',
    path: 'buyer.relay_only',
  },
  {
    name: 'model outside the catalog without custom',
    toml: BASE + offer({ model: 'my-finetune' }),
    code: 'UNKNOWN_MODEL',
    path: 'offers[0].model',
  },
  {
    name: 'catalog model flagged as custom',
    toml: BASE + offer({ extra: 'custom = true' }),
    code: 'CUSTOM_MODEL_IN_CATALOG',
    path: 'offers[0].custom',
  },
  {
    name: 'custom model with an invalid identifier',
    toml: BASE + offer({ model: 'bad model!', extra: 'custom = true' }),
    code: 'INVALID_VALUE',
    path: 'offers[0].model',
  },
  {
    name: 'unsupported engine kind',
    toml:
      BASE +
      offer({ engine: '{ kind = "vllm", url = "http://127.0.0.1:8000" }' }),
    code: 'INVALID_VALUE',
    path: 'offers[0].engine.kind',
  },
  {
    name: 'engine missing url',
    toml: BASE + offer({ engine: '{ kind = "ollama" }' }),
    code: 'MISSING_KEY',
    path: 'offers[0].engine.url',
  },
  {
    name: 'remote engine over plain http',
    toml:
      BASE +
      offer({
        engine: '{ kind = "openai", url = "http://api.example.com/v1" }',
      }),
    code: 'INSECURE_URL',
    path: 'offers[0].engine.url',
  },
  {
    name: 'engine url with user info',
    toml:
      BASE +
      offer({
        engine: `{ kind = "openai", url = "https://user:${FAKE_SECRET}@api.example.com/v1" }`,
      }),
    code: 'INLINE_SECRET',
    path: 'offers[0].engine.url',
  },
  {
    name: 'engine url with a key in the query',
    toml:
      BASE +
      offer({
        engine: `{ kind = "openai", url = "https://api.example.com/v1?api_key=${FAKE_SECRET}" }`,
      }),
    code: 'INLINE_SECRET',
    path: 'offers[0].engine.url',
  },
  {
    name: 'inline engine api key',
    toml:
      BASE +
      offer({
        engine: `{ kind = "openai", url = "https://api.example.com/v1", api_key = "${FAKE_SECRET}" }`,
      }),
    code: 'INLINE_SECRET',
    path: 'offers[0].engine.api_key',
  },
  {
    name: 'unknown engine key',
    toml:
      BASE +
      offer({
        engine:
          '{ kind = "ollama", url = "http://127.0.0.1:11434", timeout = 5 }',
      }),
    code: 'UNKNOWN_KEY',
    path: 'offers[0].engine.timeout',
  },
  {
    name: 'empty upstream model',
    toml:
      BASE +
      offer({
        engine:
          '{ kind = "ollama", url = "http://127.0.0.1:11434", upstream_model = "" }',
      }),
    code: 'INVALID_VALUE',
    path: 'offers[0].engine.upstream_model',
  },
  {
    name: 'unknown reasoning level',
    toml: BASE + offer({ extra: 'reasoning = ["turbo"]' }),
    code: 'INVALID_VALUE',
    path: 'offers[0].reasoning[0]',
  },
  {
    name: 'repeated reasoning level',
    toml: BASE + offer({ extra: 'reasoning = ["off", "off"]' }),
    code: 'DUPLICATE_VALUE',
    path: 'offers[0].reasoning[1]',
  },
  {
    name: 'empty reasoning list',
    toml: BASE + offer({ extra: 'reasoning = []' }),
    code: 'INVALID_VALUE',
    path: 'offers[0].reasoning',
  },
  {
    name: 'non-canonical price',
    toml: BASE + offer({ pricing: price('"0.10"', '"0.4"') }),
    code: 'NON_CANONICAL_DECIMAL',
    path: 'offers[0].price.input_per_mtok',
  },
  {
    name: 'price as a float',
    toml: BASE + offer({ pricing: price('"0.1"', '0.4') }),
    code: 'WRONG_TYPE',
    path: 'offers[0].price.output_per_mtok',
  },
  {
    name: 'price above the maximum',
    toml: BASE + offer({ pricing: price('"12345"', '"0.4"') }),
    code: 'PRICE_OUT_OF_RANGE',
    path: 'offers[0].price.input_per_mtok',
  },
  {
    name: 'price finer than USDC precision',
    toml: BASE + offer({ pricing: price('"0.1"', '"0.0000001"') }),
    code: 'PRICE_OUT_OF_RANGE',
    path: 'offers[0].price.output_per_mtok',
  },
  {
    name: 'zero price on both sides',
    toml: BASE + offer({ pricing: price('"0"', '"0"') }),
    code: 'PRICE_ZERO',
    path: 'offers[0].price',
  },
  {
    name: 'currency other than USDC',
    toml: BASE + offer({ pricing: price('"0.1"', '"0.4"', 'USD') }),
    code: 'INVALID_VALUE',
    path: 'offers[0].price.currency',
  },
  {
    name: 'price and free together',
    toml:
      BASE +
      offer({
        extra: 'free = { daily_token_cap = 200000, per_buyer_cap = 5000 }',
      }),
    code: 'PRICING_CONFLICT',
    path: 'offers[0]',
  },
  {
    name: 'neither price nor free',
    toml: BASE + offer({ pricing: '' }),
    code: 'PRICING_MISSING',
    path: 'offers[0]',
  },
  {
    name: 'zero daily cap',
    toml:
      BASE +
      offer({
        pricing: 'free = { daily_token_cap = 0, per_buyer_cap = 5000 }',
      }),
    code: 'INVALID_CAP',
    path: 'offers[0].free.daily_token_cap',
  },
  {
    name: 'per-buyer cap above the daily cap',
    toml:
      BASE +
      offer({
        pricing: 'free = { daily_token_cap = 1000, per_buyer_cap = 5000 }',
      }),
    code: 'INVALID_CAP',
    path: 'offers[0].free.per_buyer_cap',
    schemaAccepts: true,
  },
  {
    name: 'same model offered twice through an alias',
    toml:
      BASE + offer({ model: 'qwen3-0.6b' }) + offer({ model: 'qwen3:0.6b' }),
    code: 'DUPLICATE_VALUE',
    path: 'offers[1].model',
    schemaAccepts: true,
  },
  {
    name: 'more offers than allowed',
    toml:
      BASE +
      Array.from({ length: 33 }, (_, index) =>
        offer({ model: `custom-${index}`, extra: 'custom = true' }),
      ).join(''),
    code: 'TOO_MANY',
    path: 'offers',
  },
  {
    name: 'secret nested in an unknown table',
    toml: `${BASE}[auth]\ntoken = "${FAKE_SECRET}"\n`,
    code: 'INLINE_SECRET',
    path: 'auth.token',
  },
  {
    name: 'broken TOML',
    toml: `${BASE}api_key = "${FAKE_SECRET}\n`,
    code: 'TOML_SYNTAX',
    path: '',
  },
];

export const VALID_FIXTURES: readonly { name: string; toml: string }[] = [
  { name: 'minimal', toml: BASE },
  {
    name: 'custom model',
    toml:
      BASE +
      offer({
        model: 'acme/chat-large',
        extra: 'custom = true\nreasoning = ["off", "high"]',
        engine:
          '{ kind = "anthropic", url = "https://api.example.com", api_key_env = "UPSTREAM_API_KEY", upstream_model = "acme-chat-large-2026" }',
      }),
  },
  {
    name: 'free offer',
    toml:
      BASE +
      offer({
        model: 'qwen3-0.6b',
        pricing: 'free = { daily_token_cap = 200000, per_buyer_cap = 5000 }',
      }),
  },
  {
    name: 'every section',
    toml: [
      'version = 1',
      '[node]',
      'network = "devnet"',
      'data_dir = "/data"',
      // Synthetic 32-byte address; not a wallet anyone controls.
      `payout_wallet = "${SYNTHETIC_ADDRESS}"`,
      'rpc_url = "https://api.devnet.solana.com"',
      '[relays]',
      'urls = ["https://na1.relay.gyblos.com"]',
      'relay_token_env = "GYBLOS_RELAY_TOKEN"',
      '[transport]',
      'relay_only = false',
      'bind = "0.0.0.0:7843"',
      'external_addr = "203.0.113.7:7843"',
      '[buyer]',
      'relay_only = true',
      '[discovery]',
      'publish = true',
      'url = "http://127.0.0.1:8787/v1"',
      '',
    ].join('\n'),
  },
];

export function exampleFiles() {
  return readdirSync(EXAMPLES_DIRECTORY)
    .filter((name) => name.endsWith('.toml'))
    .sort()
    .map((name) => ({
      name,
      path: join(EXAMPLES_DIRECTORY, name),
      toml: readFileSync(join(EXAMPLES_DIRECTORY, name), 'utf8'),
    }));
}
