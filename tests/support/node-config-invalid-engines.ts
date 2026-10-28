// Invalid gyblos.toml engine fixtures: the context size remote engine kinds require and
// Ollama refuses. Test data only;
// spread into INVALID_FIXTURES.
import { BASE, offer } from './node-config-fixtures';
import type { InvalidConfigFixture } from './node-config-invalid';

export const ENGINE_FIXTURES: readonly InvalidConfigFixture[] = [
  {
    name: 'remote engine without its context size',
    toml:
      BASE +
      offer({
        engine: '{ kind = "openai", url = "https://api.example.com/v1" }',
      }),
    code: 'MISSING_KEY',
    path: 'offers[0].engine.context_tokens',
  },
  {
    name: 'anthropic engine without its context size',
    toml:
      BASE +
      offer({
        engine: '{ kind = "anthropic", url = "https://api.example.com" }',
      }),
    code: 'MISSING_KEY',
    path: 'offers[0].engine.context_tokens',
  },
  {
    name: 'context size below the minimum',
    toml:
      BASE +
      offer({
        engine:
          '{ kind = "openai", url = "https://api.example.com/v1", context_tokens = 1023 }',
      }),
    code: 'INVALID_VALUE',
    path: 'offers[0].engine.context_tokens',
  },
  {
    name: 'context size above the maximum',
    toml:
      BASE +
      offer({
        engine:
          '{ kind = "openai", url = "https://api.example.com/v1", context_tokens = 2000001 }',
      }),
    code: 'INVALID_VALUE',
    path: 'offers[0].engine.context_tokens',
  },
  {
    name: 'context size as a float',
    toml:
      BASE +
      offer({
        engine:
          '{ kind = "openai", url = "https://api.example.com/v1", context_tokens = 131072.0 }',
      }),
    code: 'WRONG_TYPE',
    path: 'offers[0].engine.context_tokens',
  },
  {
    name: 'context size on an ollama engine',
    toml:
      BASE +
      offer({
        engine:
          '{ kind = "ollama", url = "http://127.0.0.1:11434", context_tokens = 4096 }',
      }),
    code: 'INVALID_VALUE',
    path: 'offers[0].engine.context_tokens',
  },
];
