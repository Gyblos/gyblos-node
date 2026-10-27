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
    // The GYB-DOC-026 decision example writes prices with trailing zeros.
    name: 'decision example prices with trailing zeros',
    toml:
      BASE +
      offer({
        pricing:
          'price = { input_per_mtok = "0.10", output_per_mtok = "0.40", currency = "USDC" }',
      }) +
      offer({
        model: 'qwen3-30b-a3b',
        pricing:
          'price = { input_per_mtok = "0.30", output_per_mtok = "0.60", currency = "USDC" }',
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
      '[limits]',
      'max_connections = 16',
      'max_peer_connections = 2',
      'requests_per_minute = 60',
      'global_requests_per_minute = 512',
      'max_free_buyers_per_day = 2048',
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
