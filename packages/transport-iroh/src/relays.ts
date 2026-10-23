// Owns the shared operator relay map and public relay admission policy.
// Credentials come only from the environment and must never enter diagnostics or URLs.
import { RelayMap, RelayMode } from '@number0/iroh';

import { IROH_RELAYS } from '@gyblos/config';

import {
  RELAY_CONFIGURATION_CODES,
  type RelayConfigurationCode,
} from './constants.js';

export interface RelayEnvironment extends NodeJS.ProcessEnv {
  GYBLOS_RELAYS?: string;
  GYBLOS_RELAY_TOKEN?: string;
}

export class RelayConfigurationError extends Error {
  constructor(
    readonly code: RelayConfigurationCode,
    message: string,
  ) {
    super(message);
    this.name = 'RelayConfigurationError';
  }
}

export function configuredRelayUrls(
  environment: RelayEnvironment = process.env,
) {
  const values = environment.GYBLOS_RELAYS?.split(',') ?? IROH_RELAYS.urls;
  try {
    return [
      ...new Set(
        values.map((value) => {
          const url = new URL(value.trim());
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/'
          )
            throw new RelayConfigurationError(
              RELAY_CONFIGURATION_CODES.INVALID_URLS,
              'Invalid relay origin.',
            );
          return url.href;
        }),
      ),
    ];
  } catch {
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.INVALID_URLS,
      'GYBLOS_RELAYS must contain HTTPS relay origins without credentials, paths, queries or fragments.',
    );
  }
}

export function relayModeFromEnv(environment: RelayEnvironment = process.env) {
  const urls = configuredRelayUrls(environment);
  const authToken = environment.GYBLOS_RELAY_TOKEN;
  if (!authToken)
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.MISSING_TOKEN,
      'GYBLOS_RELAY_TOKEN is required to connect to the configured relays.',
    );
  if (!/^[\x21-\x7e]+$/.test(authToken))
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.INVALID_TOKEN,
      'GYBLOS_RELAY_TOKEN must be a nonempty token without whitespace or control characters.',
    );
  try {
    const map = RelayMap.empty();
    for (const url of urls)
      map.insert({ url, quicPort: IROH_RELAYS.quicPort, authToken });
    return RelayMode.custom(map);
  } catch {
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.MAP_FAILED,
      'The configured relay map could not be created.',
    );
  }
}

export function assertConfiguredRelay(
  relayUrl: string,
  environment: RelayEnvironment = process.env,
) {
  const urls = configuredRelayUrls(environment);
  let normalized: string | undefined;
  try {
    normalized = new URL(relayUrl).href;
  } catch {
    // Reject malformed remote data without reflecting it into diagnostics.
  }
  if (!normalized || !urls.includes(normalized))
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.UNCONFIGURED,
      'Unconfigured relay rejected.',
    );
}
