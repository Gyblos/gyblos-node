import { parseArgs } from 'node:util';

import { runMode } from '@gyblos/config';
import {
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  fetchSellerProfile,
  submitSellerProfile,
  type DiscoveryFetch,
} from '@gyblos/discovery-http';
import { nodeKeySigner } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  parseSellerName,
  PROFILE_CLAIM,
  SELLER_NAME_ISSUES,
  signProfileClaim,
  type SellerNameIssue,
} from '@gyblos/protocol/profile-claim';

import { urlOrigin } from './cli-format';
import { commandsFor } from './cli-next';
import {
  clockGapSeconds,
  indexHint,
  ISSUE_TEXT,
  SHOW_DELAY,
  TERMINAL_HINT,
  UNVERIFIED,
} from './cli-seller-name-text';
import { EXIT, NAME_ERRORS, SELLER_NAME } from './constants';
import {
  discoverySettings,
  homeEnvironmentOf,
  sellerIdentity,
  type SellerOutput,
} from './seller-home';
import { fail, RETRY_LATER } from './verify-github-index';

export interface NameContext {
  env: SellerOutput['env'];
  cwd?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: DiscoveryFetch;
  interrupt?: AbortSignal;
}

interface NameSession {
  output: SellerOutput;
  environment: SellerOutput['env'];
  nodeId: string;
  baseUrl: string;
  fetch: DiscoveryFetch;
  interrupt: AbortSignal | undefined;
  serverDate: string | null;
}

const USAGE =
  'Usage: gyblos seller name "<name>"\n       gyblos seller name -- "-<name>"   (for a name that starts with -)\n       gyblos seller name --clear\n       gyblos seller name --status\n';
class SigningFailed extends Error {}

function indexFailure(session: NameSession, error: unknown) {
  const mode = runMode(session.output.env);
  if (error instanceof SigningFailed)
    return fail(
      session.output,
      NAME_ERRORS.SIGNING_FAILED,
      commandsFor(
        mode,
        "This seller's node key could not sign the name. Run `gyblos doctor`",
      ),
    );
  if (!(error instanceof DiscoveryError)) throw error;
  if (error.code === DISCOVERY_ERROR_CODES.CANCELLED) {
    session.output.stderr('Stopped. Nothing more was sent.\n');
    return EXIT.interrupted;
  }
  return fail(
    session.output,
    error.code,
    commandsFor(
      mode,
      indexHint(error.code, clockGapSeconds(session.serverDate, Date.now())),
    ),
  );
}

async function signed(session: NameSession, name: string | null) {
  try {
    const signer = await nodeKeySigner(P2P_ROLES.SELLER, session.environment);
    return await signProfileClaim(
      {
        schemaVersion: PROFILE_CLAIM.schemaVersion,
        nodeId: session.nodeId,
        name,
        issuedAt: Date.now(),
      },
      signer,
    );
  } catch {
    throw new SigningFailed();
  }
}

async function send(session: NameSession, name: string | null) {
  const where = `seller ${session.nodeId} in ${urlOrigin(session.baseUrl)}`;
  let answer: { name: string | null };
  try {
    answer = await submitSellerProfile({
      baseUrl: session.baseUrl,
      signed: await signed(session, name),
      fetch: session.fetch,
      timeoutMs: SELLER_NAME.indexTimeoutMs,
      signal: session.interrupt,
    });
  } catch (error) {
    return indexFailure(session, error);
  }
  if (answer.name !== name)
    return fail(
      session.output,
      DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
      RETRY_LATER,
    );
  const unverified = commandsFor(runMode(session.output.env), UNVERIFIED);
  session.output.stdout(
    name === null
      ? `Name cleared: ${where} shows no name. ${SHOW_DELAY}.\n`
      : `Name set: ${where} shows "${name}". ${SHOW_DELAY}.\n  ${unverified}.\n`,
  );
  return EXIT.ok;
}

async function status(session: NameSession) {
  const where = `seller ${session.nodeId} in ${urlOrigin(session.baseUrl)}`;
  try {
    const view = await fetchSellerProfile({
      baseUrl: session.baseUrl,
      nodeId: session.nodeId,
      fetch: session.fetch,
      timeoutMs: SELLER_NAME.indexTimeoutMs,
      signal: session.interrupt,
    });
    session.output.stdout(
      view
        ? `Public name for ${where}: "${view.name}" (set ${new Date(view.issuedAt).toISOString()}).\n  ${commandsFor(runMode(session.output.env), UNVERIFIED)}.\n`
        : `No public name for ${where}.\n`,
    );
    return EXIT.ok;
  } catch (error) {
    return indexFailure(session, error);
  }
}

function parseName(args: readonly string[]) {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { clear: { type: 'boolean' }, status: { type: 'boolean' } },
      allowPositionals: true,
    });
    const { clear, status: showing } = parsed.values;
    const given = parsed.positionals.length > 0;
    if ([clear, showing, given].filter(Boolean).length !== 1) return undefined;
    return {
      clear: clear === true,
      status: showing === true,
      name: given ? parsed.positionals.join(' ') : null,
    };
  } catch {
    return undefined;
  }
}

export async function nameCommand(
  args: readonly string[],
  context: NameContext,
) {
  const output: SellerOutput = {
    env: context.env,
    cwd: context.cwd ?? process.cwd(),
    stdout: context.stdout,
    stderr: context.stderr,
  };
  const parsed = parseName(args);
  if (!parsed) {
    output.stderr(USAGE);
    return EXIT.failure;
  }
  let name: string | null = null;
  if (parsed.name !== null) {
    const checked = parseSellerName(parsed.name);
    if (!checked.ok)
      return fail(
        output,
        checked.issue === SELLER_NAME_ISSUES.RESERVED
          ? NAME_ERRORS.RESERVED
          : NAME_ERRORS.INVALID,
        ISSUE_TEXT[checked.issue] +
          (SELLER_NAME.garbled.test(parsed.name) ? TERMINAL_HINT : ''),
      );
    name = checked.name;
  }
  const environment = homeEnvironmentOf(output);
  const identity = await sellerIdentity(environment, output);
  if (!identity) return EXIT.failure;
  const discovery = await discoverySettings(output, true);
  if (!discovery)
    return fail(
      output,
      NAME_ERRORS.CONFIG_INVALID,
      commandsFor(
        runMode(output.env),
        'The configuration is invalid. Run `gyblos doctor`',
      ),
    );
  const base: DiscoveryFetch =
    context.fetch ?? ((input, init) => fetch(input, init));
  const session: NameSession = {
    output,
    environment,
    nodeId: identity.nodeId,
    baseUrl: discovery.url,
    fetch: async (input, init) => {
      const response = await base(input, init);
      session.serverDate = response.headers.get('date');
      return response;
    },
    interrupt: context.interrupt,
    serverDate: null,
  };
  if (parsed.status) return status(session);
  return send(session, name);
}
