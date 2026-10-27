// Owns the shared operator relay map and public relay admission policy.
// Credentials come only from the environment, reach only owned relays and never enter diagnostics.
import { RelayMap, RelayMode } from '@number0/iroh';

import { IROH_RELAYS } from '@gyblos/config';

import {
  RELAY_CONFIGURATION_CODES,
  RELAY_TOKEN_LENGTH,
  type RelayConfigurationCode,
} from './constants';
import { relayOrigins } from './relay-origins';

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

function configuredRelayUrls(environment: RelayEnvironment = process.env) {
  const values = environment.GYBLOS_RELAYS?.split(',') ?? IROH_RELAYS.urls;
  const origins = relayOrigins(values);
  if (!origins)
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.INVALID_URLS,
      'GYBLOS_RELAYS must contain HTTPS relay origins without credentials, paths, queries or fragments.',
    );
  return origins;
}

function relayToken(environment: RelayEnvironment) {
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
  if (
    authToken.length < RELAY_TOKEN_LENGTH.min ||
    authToken.length > RELAY_TOKEN_LENGTH.max
  )
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.INVALID_TOKEN_LENGTH,
      `GYBLOS_RELAY_TOKEN must contain ${RELAY_TOKEN_LENGTH.min} to ${RELAY_TOKEN_LENGTH.max} characters.`,
    );
  return authToken;
}

function isOwnedRelay(url: string) {
  const { hostname } = new URL(url);
  return IROH_RELAYS.ownedHosts.some((host) => host === hostname);
}

export function relayModeFromEnv(environment: RelayEnvironment = process.env) {
  const urls = configuredRelayUrls(environment);
  const authToken = relayToken(environment);
  try {
    const map = RelayMap.empty();
    for (const url of urls)
      map.insert(
        isOwnedRelay(url)
          ? { url, quicPort: IROH_RELAYS.quicPort, authToken }
          : { url, quicPort: IROH_RELAYS.quicPort },
      );
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
  return normalized;
}

export function requireConfiguredRelay(
  relayUrl: string | null | undefined,
  environment: RelayEnvironment = process.env,
) {
  if (!relayUrl)
    throw new RelayConfigurationError(
      RELAY_CONFIGURATION_CODES.REQUIRED,
      'Relay-only mode requires a configured relay in the seller offer.',
    );
  return assertConfiguredRelay(relayUrl, environment);
}
