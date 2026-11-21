// `gyblos seller rpc [set|reset]`: shows, sets or resets the Solana RPC the seller reads from its role file at
// startup. The public devnet RPC is the default; an operator with its own endpoint sets it here instead of
// reinstalling. The URL comes from GYBLOS_RPC_URL or a terminal question, never an argument, because
// providers embed API keys in it, and output shows only its origin. A URL is saved only once it answers as
// devnet, so a seller never spends real SOL by mistake.
import {
  DEVNET_GENESIS,
  DEVNET_RPC_URL,
  NODE_ENVIRONMENT,
} from '@gyblos/config';
import { configurationRpcUrl } from '@gyblos/node/configuration';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';
import { setRoleRpcUrl } from '@gyblos/node/role-rpc';
import { loadRole } from '@gyblos/node/roles';
import { readGenesis, type GenesisReader } from '@gyblos/node/seller-chain';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { urlOrigin } from './cli-format';
import type { Prompt } from './cli-init';
import { EXIT } from './constants';

export interface RpcCommandContext {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  prompt?: Prompt;
  // The chain an RPC serves; tests inject one so they never reach the network.
  genesis?: GenesisReader;
}

const USAGE =
  'Usage: gyblos seller rpc          (shows the RPC this seller uses)\n       gyblos seller rpc set      (the URL from GYBLOS_RPC_URL, or asked for on a terminal)\n       gyblos seller rpc reset    (back to the public devnet RPC)\n';
const RESTART =
  'Restart the seller to use it: Docker, `docker compose restart seller` where you installed it; background service, `gyblos seller service uninstall`, then `gyblos seller service install`; otherwise stop `gyblos start` and run it again.\n';
const NO_SELLER =
  'gyblos seller rpc: no seller is set up in this home; run setup first.\n';

const environment = (values: RpcCommandContext['env']) =>
  values as Record<string, string | undefined>;

async function urlOf(context: RpcCommandContext) {
  const given = context.env[NODE_ENVIRONMENT.rpcUrl];
  if (given !== undefined) return given.trim();
  if (!context.prompt) return undefined;
  return (
    await context.prompt('Solana devnet RPC URL (it is not shown again): ')
  ).trim();
}

async function save(context: RpcCommandContext, raw: string) {
  let url: string;
  try {
    url = configurationRpcUrl(raw, NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION);
  } catch {
    context.stderr(
      'gyblos seller rpc: not an http(s) URL; nothing was changed.\n',
    );
    return EXIT.failure;
  }
  const genesis = context.genesis ?? readGenesis;
  const served = await genesis(url).catch(() => undefined);
  if (served !== DEVNET_GENESIS) {
    context.stderr(
      `gyblos seller rpc: ${urlOrigin(url)} did not answer as Solana devnet; nothing was changed.\n`,
    );
    return EXIT.failure;
  }
  await setRoleRpcUrl(P2P_ROLES.SELLER, url, environment(context.env));
  context.stdout(`Saved: this seller now uses ${urlOrigin(url)}.\n${RESTART}`);
  return EXIT.ok;
}

async function sellerRole(context: RpcCommandContext) {
  try {
    const role = await loadRole(P2P_ROLES.SELLER, environment(context.env));
    return role.role === P2P_ROLES.SELLER ? role : undefined;
  } catch {
    return undefined;
  }
}

export async function rpcCommand(
  args: readonly string[],
  context: RpcCommandContext,
) {
  const [action, ...rest] = args;
  if (
    rest.length ||
    (action !== undefined && !['set', 'reset'].includes(action))
  ) {
    context.stderr(USAGE);
    return EXIT.failure;
  }
  const role = await sellerRole(context);
  if (!role) {
    context.stderr(NO_SELLER);
    return EXIT.failure;
  }
  if (action === undefined) {
    const kind =
      role.rpcUrl === DEVNET_RPC_URL ? ' (the public devnet RPC)' : '';
    context.stdout(`This seller uses ${urlOrigin(role.rpcUrl)}${kind}.\n`);
    return EXIT.ok;
  }
  if (action === 'reset') return save(context, DEVNET_RPC_URL);
  const url = await urlOf(context);
  if (url === undefined) {
    context.stderr(
      `gyblos seller rpc set: set ${NODE_ENVIRONMENT.rpcUrl}, or run it on a terminal to be asked.\n`,
    );
    return EXIT.failure;
  }
  return save(context, url);
}
