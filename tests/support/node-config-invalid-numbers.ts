// Invalid gyblos.toml number fixtures: price decimal spellings, TOML floats where integers are
// required and [limits] ranges. Test data only; spread into INVALID_FIXTURES.
import { BASE, offer } from './node-config-fixtures';
import type { InvalidConfigFixture } from './node-config-invalid';

const price = (input: string, output: string) =>
  `price = { input_per_mtok = ${input}, output_per_mtok = ${output}, currency = "USDC" }`;

export const NUMBER_FIXTURES: readonly InvalidConfigFixture[] = [
  {
    name: 'price with a leading zero',
    toml: BASE + offer({ pricing: price('"00.1"', '"0.4"') }),
    code: 'NON_CANONICAL_DECIMAL',
    path: 'offers[0].price.input_per_mtok',
  },
  {
    name: 'price with an empty fraction',
    toml: BASE + offer({ pricing: price('"1."', '"0.4"') }),
    code: 'NON_CANONICAL_DECIMAL',
    path: 'offers[0].price.input_per_mtok',
  },
  {
    name: 'price with an empty integer part',
    toml: BASE + offer({ pricing: price('"0.1"', '".4"') }),
    code: 'NON_CANONICAL_DECIMAL',
    path: 'offers[0].price.output_per_mtok',
  },
  {
    name: 'price with a sign',
    toml: BASE + offer({ pricing: price('"+0.1"', '"0.4"') }),
    code: 'NON_CANONICAL_DECIMAL',
    path: 'offers[0].price.input_per_mtok',
  },
  {
    name: 'price with an exponent',
    toml: BASE + offer({ pricing: price('"1e-3"', '"0.4"') }),
    code: 'NON_CANONICAL_DECIMAL',
    path: 'offers[0].price.input_per_mtok',
  },
  {
    name: 'price finer than USDC precision once trailing zeros are dropped',
    toml: BASE + offer({ pricing: price('"0.1"', '"0.00000010"') }),
    code: 'PRICE_OUT_OF_RANGE',
    path: 'offers[0].price.output_per_mtok',
  },
  {
    name: 'zero price written with trailing zeros',
    toml: BASE + offer({ pricing: price('"0.00"', '"0.0"') }),
    code: 'PRICE_ZERO',
    path: 'offers[0].price',
  },
  {
    name: 'version written as a float',
    toml: BASE.replace('version = 1', 'version = 1.0'),
    code: 'WRONG_TYPE',
    path: 'version',
  },
  {
    name: 'cap written as a float',
    toml:
      BASE +
      offer({
        pricing: 'free = { daily_token_cap = 10.0, per_buyer_cap = 5 }',
      }),
    code: 'WRONG_TYPE',
    path: 'offers[0].free.daily_token_cap',
  },
  {
    name: 'cap written with an exponent',
    toml:
      BASE +
      offer({
        pricing: 'free = { daily_token_cap = 1e3, per_buyer_cap = 5 }',
      }),
    code: 'WRONG_TYPE',
    path: 'offers[0].free.daily_token_cap',
  },
  {
    name: 'cap above the largest safe integer',
    toml:
      BASE +
      offer({
        pricing:
          'free = { daily_token_cap = 9007199254740993, per_buyer_cap = 5 }',
      }),
    code: 'INVALID_CAP',
    path: 'offers[0].free.daily_token_cap',
  },
  {
    name: 'limit above its ceiling',
    toml: `${BASE}[limits]\nmax_connections = 65\n`,
    code: 'INVALID_LIMIT',
    path: 'limits.max_connections',
  },
  {
    name: 'zero limit',
    toml: `${BASE}[limits]\nrequests_per_minute = 0\n`,
    code: 'INVALID_LIMIT',
    path: 'limits.requests_per_minute',
  },
  {
    name: 'unknown limit',
    toml: `${BASE}[limits]\nmax_concurrent = 2\n`,
    code: 'UNKNOWN_KEY',
    path: 'limits.max_concurrent',
  },
  {
    name: 'request budget that cannot cover the connection pool',
    toml: `${BASE}[limits]\nrequests_per_minute = 60\n`,
    code: 'INVALID_LIMIT',
    path: 'limits.requests_per_minute',
    // 8 connections x 60 exceeds the built-in 256 total; a cross-field rule.
    schemaAccepts: true,
  },
];
