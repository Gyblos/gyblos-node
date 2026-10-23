// Pinned SDK versions read from this package's manifest, so evidence records the exact dependency.
import manifest from '../package.json' with { type: 'json' };

export const X402_SDK_VERSION = manifest.dependencies['@x402/core'];

export const TOKENIZER_SDK_VERSION =
  manifest.dependencies['@huggingface/tokenizers'];
