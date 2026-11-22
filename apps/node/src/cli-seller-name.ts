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
}

const USAGE =
  'Usage: gyblos seller name "<name>"\n       gyblos seller name --clear\n       gyblos seller name --status\n';
const UNVERIFIED =
  'Names are chosen by each seller: they are not verified and not unique. Only `gyblos seller verify github` verifies who runs a seller';
const AGAIN = 'Run the same command again';

const ISSUE_TEXT: Readonly<Record<SellerNameIssue, string>> = {
  [SELLER_NAME_ISSUES.LENGTH]: `A seller name has ${PROFILE_CLAIM.minNameCharacters} to ${PROFILE_CLAIM.maxNameCharacters} characters`,
  [SELLER_NAME_ISSUES.CHARACTERS]:
    "A seller name may use only letters, numbers, spaces and - _ . ' (no emoji, symbols or check marks), with at least one letter or number",
  [SELLER_NAME_ISSUES.RESERVED]: `A seller name may not contain "${PROFILE_CLAIM.reservedWord}" in any letter case`,
};
const INDEX_HINTS: ReadonlyMap<string, string> = new Map([
  [
    DISCOVERY_ERROR_CODES.UNKNOWN_NODE,
    `The index does not know this seller yet. Register it with \`gyblos seller register\`, or start it with publishing on, then ${AGAIN.toLowerCase()}`,
  ],
  [
    DISCOVERY_ERROR_CODES.RATE_LIMITED,
    `The index got too many attempts. Wait a minute and ${AGAIN.toLowerCase()}`,
  ],
  [
    DISCOVERY_ERROR_CODES.UNAVAILABLE,
    `The index does not take seller names right now. ${AGAIN} later`,
  ],
  [
    DISCOVERY_ERROR_CODES.STALE_CLAIM,
    `The index holds a newer name from this seller. Check this computer's clock, then ${AGAIN.toLowerCase()}`,
  ],
  [
    DISCOVERY_ERROR_CODES.CLAIM_REJECTED,
    `The index refused the name. Check this computer's clock, then ${AGAIN.toLowerCase()}`,
  ],
  [
    DISCOVERY_ERROR_CODES.INVALID_SIGNATURE,
    'The index refused the signature. Run `gyblos doctor`',
  ],
  [
    DISCOVERY_ERROR_CODES.HTTP_STATUS,
    'This index does not take seller names. Check discovery.url in config.toml',
  ],
  [
    DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
    'The index sent an answer this version cannot read. Update gyblos, or try again later',
  ],
]);

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
    commandsFor(mode, INDEX_HINTS.get(error.code) ?? RETRY_LATER),
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
  session.output.stdout(
    name === null
      ? `Name cleared: ${where} shows no name.\n`
      : `Name set: ${where} shows "${name}".\n  ${UNVERIFIED}.\n`,
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
        ? `Public name for ${where}: "${view.name}" (set ${new Date(view.issuedAt).toISOString()}).\n  ${UNVERIFIED}.\n`
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
        ISSUE_TEXT[checked.issue],
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
  const session: NameSession = {
    output,
    environment,
    nodeId: identity.nodeId,
    baseUrl: discovery.url,
    fetch: context.fetch ?? ((input, init) => fetch(input, init)),
    interrupt: context.interrupt,
  };
  if (parsed.status) return status(session);
  return send(session, name);
}
