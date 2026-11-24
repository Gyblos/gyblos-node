// `gyblos seller rpc [set|reset]`: shows, sets or resets the Solana RPC the seller reads from its role file at
// startup. The public devnet RPC is the default; an operator with its own endpoint sets it here instead of
// reinstalling. The URL comes from GYBLOS_RPC_URL or a terminal question, never an argument, because
// providers embed API keys in it, and output shows only its origin. A URL is saved only once it answers as
// devnet, so a seller never spends real SOL by mistake.
import {
  DEVNET_GENESIS,
  DEVNET_RPC_URL,
  LOOPBACK_HOST_NAMES,
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
import { EXIT, RPC_COMMANDS } from './constants';

export interface RpcCommandContext {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  prompt?: Prompt;
  // The chain an RPC serves; tests inject one so they never reach the network.
  genesis?: GenesisReader;
}

const USAGE =
  'Usage: gyblos seller rpc          (shows the RPC this seller uses)\n       gyblos seller rpc set      (asked for on a terminal; scripts set GYBLOS_RPC_URL)\n       gyblos seller rpc reset    (back to the public devnet RPC)\n';
const RESTART =
  'Restart the seller to use it: Docker, `docker compose restart seller` where you installed it; background service, `gyblos seller service restart`, which keeps its settings; otherwise stop `gyblos start` and run it again.\n';
const NO_SELLER =
  'gyblos seller rpc: no seller is set up in this home; run setup first.\n';
const UNWRITABLE =
  "gyblos seller rpc: this seller's role file cannot be written; nothing was changed.\n";
const STALE_MESSAGE = `gyblos seller rpc set: ${NODE_ENVIRONMENT.rpcUrl} already uses this seller's RPC; run it on a terminal (for Docker, \`docker compose exec\` without -T) to be asked for the new one.
`;
// urlOf's answer when GYBLOS_RPC_URL is the saved RPC and no terminal can be asked.
const STALE = Symbol('stale');
const UNREADABLE =
  "gyblos seller rpc: this seller's role file cannot be read; nothing was changed.\n";
const HELP = new Set(['--help', '-h']);
const LOCAL_HOSTS: ReadonlySet<string> = new Set(LOOPBACK_HOST_NAMES);

const environment = (values: RpcCommandContext['env']) =>
  values as Record<string, string | undefined>;

const sameUrl = (left: string, right: string) => {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
};

// The new URL: asked on a terminal, always, since GYBLOS_RPC_URL may be the first install's value Docker's
// seller.env keeps in the container. Without a terminal (a script), GYBLOS_RPC_URL, unless it is the RPC
// already saved.
async function urlOf(context: RpcCommandContext, current: string) {
  if (context.prompt)
    return (await context.prompt('Solana devnet RPC URL: ')).trim();
  const given = context.env[NODE_ENVIRONMENT.rpcUrl]?.trim();
  if (given === undefined) return undefined;
  if (sameUrl(given, current)) return STALE;
  context.stdout(`Using ${NODE_ENVIRONMENT.rpcUrl}.\n`);
  return given;
}

async function save(context: RpcCommandContext, raw: string, check = true) {
  let url: string;
  try {
    url = configurationRpcUrl(raw, NODE_ERROR_CODES.INVALID_ROLE_CONFIGURATION);
  } catch {
    url = '';
  }
  // The URL carries the provider's key and every answer the fee payer relies on: plain http only locally.
  const parsed = url ? new URL(url) : undefined;
  if (
    !parsed ||
    (parsed.protocol === 'http:' && !LOCAL_HOSTS.has(parsed.hostname))
  ) {
    context.stderr(
      'gyblos seller rpc: not an https URL (http only on this computer); nothing was changed.\n',
    );
    return EXIT.failure;
  }
  const genesis = context.genesis ?? readGenesis;
  const served = check
    ? await genesis(url).catch(() => undefined)
    : DEVNET_GENESIS;
  if (served !== DEVNET_GENESIS) {
    context.stderr(
      `gyblos seller rpc: ${urlOrigin(url)} did not answer as Solana devnet; nothing was changed.\n`,
    );
    return EXIT.failure;
  }
  try {
    await setRoleRpcUrl(P2P_ROLES.SELLER, url, environment(context.env));
  } catch {
    context.stderr(UNWRITABLE);
    return EXIT.failure;
  }
  context.stdout(`Saved: this seller now uses ${urlOrigin(url)}.\n${RESTART}`);
  return EXIT.ok;
}

// The seller role, or the message saying why there is none: missing, or present but unreadable.
async function sellerRole(context: RpcCommandContext) {
  try {
    const role = await loadRole(P2P_ROLES.SELLER, environment(context.env));
    return role.role === P2P_ROLES.SELLER ? role : NO_SELLER;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? NO_SELLER
      : UNREADABLE;
  }
}

export async function rpcCommand(
  args: readonly string[],
  context: RpcCommandContext,
) {
  const [action, ...rest] = args;
  if (args.length === 1 && HELP.has(action!)) {
    context.stdout(USAGE);
    return EXIT.ok;
  }
  if (
    rest.length ||
    (action !== undefined &&
      !Object.values<string>(RPC_COMMANDS).includes(action))
  ) {
    context.stderr(USAGE);
    return EXIT.failure;
  }
  const role = await sellerRole(context);
  if (typeof role === 'string') {
    context.stderr(role);
    return EXIT.failure;
  }
  if (action === undefined) {
    const kind =
      role.rpcUrl === DEVNET_RPC_URL ? ' (the public devnet RPC)' : '';
    context.stdout(`This seller uses ${urlOrigin(role.rpcUrl)}${kind}.\n`);
    return EXIT.ok;
  }
  // The public RPC is the default every seller starts with: no need to reach it to go back to it.
  if (action === RPC_COMMANDS.RESET)
    return save(context, DEVNET_RPC_URL, false);
  const url = await urlOf(context, role.rpcUrl);
  if (url === STALE) {
    context.stderr(STALE_MESSAGE);
    return EXIT.failure;
  }
  if (url === undefined) {
    context.stderr(
      `gyblos seller rpc set: set ${NODE_ENVIRONMENT.rpcUrl}, or run it on a terminal to be asked.\n`,
    );
    return EXIT.failure;
  }
  return save(context, url);
}
