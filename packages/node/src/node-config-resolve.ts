// Resolves effective node settings with precedence CLI flag > GYBLOS_* environment > gyblos.toml > default,
// recording where each value came from. Environment parsing mirrors today's readers exactly; secrets are
// reported by variable name and presence only. Not yet wired into startup.
import {
  BUYER_RELAY_ONLY_ENV,
  DEFAULT_HOMES,
  DEVNET_RPC_URL,
  DISCOVERY_INDEX_URL,
  HOME_ENVIRONMENT,
  IROH_RELAYS,
  NODE_ENVIRONMENT,
  SELLER_DISCOVERY,
  type HomeEnvironment,
} from '@gyblos/config';
import { relayOrigins } from '@gyblos/transport-iroh/relay-origins';

import {
  NODE_CONFIG_ISSUE_CODES,
  NODE_CONFIG_SOURCES,
  NODE_NETWORKS,
  NODE_SETTINGS,
} from './constants.js';
import {
  RPC_URL_POLICY,
  serviceUrl,
  socketAddress,
  text,
} from './node-config-fields.js';
import {
  fileCandidate,
  nonEmpty,
  originPath,
  publishFromEnvironment,
  relaysFromEnvironment,
  relaysFromFlags,
  Resolution,
  rpcFromEnvironment,
  type NodeSettings,
  type ResolvedNodeConfig,
  type ResolveNodeConfigInput,
  type SecretReference,
} from './node-config-sources.js';
import { readAddress, readDiscoveryUrl } from './node-config-values.js';
import type { NodeConfig } from './node-config.js';

export type {
  NodeConfigFlags,
  NodeConfigWarning,
  NodeSettings,
  ResolvedNodeConfig,
  ResolveNodeConfigInput,
  SecretReference,
  SettingOrigin,
} from './node-config-sources.js';

function resolveLocation(resolution: Resolution, file: NodeConfig | undefined) {
  const { issues } = resolution;
  const network = resolution.choose(
    NODE_SETTINGS.NETWORK,
    [fileCandidate('node.network', file?.node.network)],
    NODE_NETWORKS.DEVNET,
  );
  const home = resolution.choose(
    NODE_SETTINGS.HOME,
    [
      resolution.flag('home', (value, path) => text(value, path, issues)),
      resolution.env(HOME_ENVIRONMENT.product, nonEmpty),
      fileCandidate('node.data_dir', file?.node.dataDir),
    ],
    DEFAULT_HOMES.product,
  );
  const rpcUrl = resolution.choose(
    NODE_SETTINGS.RPC_URL,
    [
      resolution.flag('rpcUrl', (value, path) =>
        serviceUrl(value, path, issues, RPC_URL_POLICY),
      ),
      resolution.env(NODE_ENVIRONMENT.rpcUrl, (value, path) =>
        rpcFromEnvironment(resolution, value, path),
      ),
      fileCandidate('node.rpc_url', file?.node.rpcUrl),
    ],
    DEVNET_RPC_URL,
  );
  const payoutWallet = resolution.choose<string | undefined>(
    NODE_SETTINGS.PAYOUT_WALLET,
    [
      resolution.flag('payoutWallet', (value, path) =>
        readAddress(value, path, issues),
      ),
      fileCandidate('node.payout_wallet', file?.node.payoutWallet),
    ],
    undefined,
  );
  return { network, home, rpcUrl, payoutWallet };
}

function resolveRelays(resolution: Resolution, file: NodeConfig | undefined) {
  const { issues } = resolution;
  const relayUrls = resolution.choose(
    NODE_SETTINGS.RELAY_URLS,
    [
      resolution.flag('relayUrls', (values) =>
        relaysFromFlags(resolution, values),
      ),
      resolution.env(NODE_ENVIRONMENT.relays, (value, path) =>
        relaysFromEnvironment(resolution, value, path),
      ),
      fileCandidate('relays.urls', file?.relays?.urls),
    ],
    relayOrigins(IROH_RELAYS.urls) ?? [],
  );
  const relayTokenEnv = resolution.choose(
    NODE_SETTINGS.RELAY_TOKEN_ENV,
    [fileCandidate('relays.relay_token_env', file?.relays?.relayTokenEnv)],
    NODE_ENVIRONMENT.relayToken,
  );
  const relayOnly = resolution.choose(
    NODE_SETTINGS.RELAY_ONLY,
    [
      resolution.flag('relayOnly', (value) => value),
      resolution.switchEnv(NODE_ENVIRONMENT.relayOnly),
      fileCandidate('transport.relay_only', file?.transport?.relayOnly),
    ],
    false,
  );
  const irohBind = resolution.choose<string | undefined>(
    NODE_SETTINGS.IROH_BIND,
    [
      resolution.flag('irohBind', (value, path) =>
        socketAddress(value, path, issues, 0),
      ),
      resolution.env(NODE_ENVIRONMENT.irohBind, nonEmpty),
      fileCandidate('transport.bind', file?.transport?.bind),
    ],
    undefined,
  );
  const irohExternalAddress = resolution.choose<string | undefined>(
    NODE_SETTINGS.IROH_EXTERNAL_ADDRESS,
    [
      resolution.flag('irohExternalAddress', (value, path) =>
        socketAddress(value, path, issues, 1),
      ),
      resolution.env(NODE_ENVIRONMENT.irohExternalAddress, nonEmpty),
      fileCandidate(
        'transport.external_addr',
        file?.transport?.externalAddress,
      ),
    ],
    undefined,
  );
  return { relayUrls, relayTokenEnv, relayOnly, irohBind, irohExternalAddress };
}

function resolveDiscovery(
  resolution: Resolution,
  file: NodeConfig | undefined,
) {
  const { issues } = resolution;
  const buyerRelayOnly = resolution.choose(
    NODE_SETTINGS.BUYER_RELAY_ONLY,
    [
      resolution.flag('buyerRelayOnly', (value) => value),
      resolution.switchEnv(BUYER_RELAY_ONLY_ENV),
      fileCandidate('buyer.relay_only', file?.buyer?.relayOnly),
    ],
    false,
  );
  const discoveryPublish = resolution.choose(
    NODE_SETTINGS.DISCOVERY_PUBLISH,
    [
      resolution.flag('discoveryPublish', (value) => value),
      resolution.env(SELLER_DISCOVERY.enabledEnvironment, (value, path) =>
        publishFromEnvironment(resolution, value, path),
      ),
      fileCandidate('discovery.publish', file?.discovery?.publish),
    ],
    false,
  );
  // As today, an environment URL is checked only when publishing; flag and file URLs always are.
  const discoveryUrl = resolution.choose(
    NODE_SETTINGS.DISCOVERY_URL,
    [
      resolution.flag('discoveryUrl', (value, path) =>
        readDiscoveryUrl(value, path, issues),
      ),
      resolution.env(SELLER_DISCOVERY.urlEnvironment, (value) => value),
      fileCandidate('discovery.url', file?.discovery?.url),
    ],
    DISCOVERY_INDEX_URL,
  );
  const urlOrigin = resolution.origins.find(
    (entry) => entry.setting === NODE_SETTINGS.DISCOVERY_URL,
  );
  if (discoveryPublish && urlOrigin?.source === NODE_CONFIG_SOURCES.ENV)
    readDiscoveryUrl(discoveryUrl, originPath(urlOrigin), issues);
  return { buyerRelayOnly, discoveryPublish, discoveryUrl };
}

function secretReferences(
  settings: NodeSettings,
  environment: HomeEnvironment,
  file: NodeConfig | undefined,
) {
  const references: SecretReference[] = [
    {
      path: 'relays.relay_token_env',
      env: settings.relayTokenEnv,
      present: Boolean(environment[settings.relayTokenEnv]),
    },
  ];
  (file?.offers ?? []).forEach((entry, index) => {
    if (entry.engine.apiKeyEnv)
      references.push({
        path: `offers[${index}].engine.api_key_env`,
        env: entry.engine.apiKeyEnv,
        present: Boolean(environment[entry.engine.apiKeyEnv]),
      });
  });
  return references;
}

export function resolveNodeConfig(
  input: ResolveNodeConfigInput,
): ResolvedNodeConfig {
  const { file, env: environment } = input;
  const resolution = new Resolution(environment, input.flags ?? {});
  const location = resolveLocation(resolution, file);
  const relays = resolveRelays(resolution, file);
  const discovery = resolveDiscovery(resolution, file);
  const offers = resolution.choose(
    NODE_SETTINGS.OFFERS,
    [fileCandidate('offers', file?.offers.length ? file.offers : undefined)],
    [],
  );
  if (relays.relayOnly && relays.irohExternalAddress !== undefined) {
    const origin = resolution.origins.find(
      (entry) => entry.setting === NODE_SETTINGS.IROH_EXTERNAL_ADDRESS,
    );
    resolution.issues.add(
      NODE_CONFIG_ISSUE_CODES.RELAY_ONLY_CONFLICT,
      originPath(origin),
    );
  }
  const { warnings } = resolution;
  if (resolution.issues.issues.length)
    return { ok: false, issues: resolution.issues.issues, warnings };
  const settings: NodeSettings = {
    ...location,
    ...relays,
    ...discovery,
    offers,
  };
  return {
    ok: true,
    settings,
    origins: resolution.origins,
    secrets: secretReferences(settings, environment, file),
    warnings,
  };
}
