import manifest from '../../../package.json' with { type: 'json' };

export const X402_SDK_VERSION = manifest.dependencies['@x402/core'];
