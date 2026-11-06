// `gyblos seller register`: trades a beta invite for permission to publish to the discovery index. Sends
// the index only the invite and this home's public NodeId; the index checks the NodeId's 8004 registration
// on chain itself. The invite comes from GYBLOS_INVITE or a terminal question, never from the command line,
// and is never printed; the index's origin is printed before anything is sent to it.
import {
  DISCOVERY_ERROR_CODES,
  DiscoveryError,
  registerSeller,
  REGISTRATION_FORMAT,
  REGISTRATION_RESULTS,
  type DiscoveryErrorCode,
  type DiscoveryFetch,
} from '@gyblos/discovery-http';
import { NODE_ERROR_CODES, type NodeErrorCode } from '@gyblos/node/constants';
import { NodeError } from '@gyblos/node/errors';

import { urlOrigin } from './cli-format';
import type { Prompt } from './cli-init';
import { registerOnChain, registrationSol } from './cli-register-identity';
import { EXIT, REGISTER, REGISTER_ERRORS } from './constants';
import {
  discoverySettings,
  homeEnvironmentOf,
  sellerIdentity,
  type SellerOutput,
} from './seller-home';

const HTTP_NOT_FOUND = 404;
const INVITE_SHAPE = 'gyb_ followed by 26 lowercase letters and digits 2-7';
const RETRY_LATER = 'the index could not answer; try again in a few minutes';
const NOT_OFFERED =
  'this index does not take registrations; check discovery.url or contact Gyblos';
const HINTS: ReadonlyMap<DiscoveryErrorCode, string> = new Map([
  [
    DISCOVERY_ERROR_CODES.INVITE_INVALID,
    'the invite code is wrong, already used or expired; ask Gyblos for a new one',
  ],
  [
    DISCOVERY_ERROR_CODES.IDENTITY_NOT_REGISTERED,
    'this seller is not registered on chain yet; run this command in a terminal to register it',
  ],
  [
    DISCOVERY_ERROR_CODES.NODE_REVOKED,
    'this seller was removed from the index; contact Gyblos',
  ],
  [
    DISCOVERY_ERROR_CODES.RATE_LIMITED,
    'too many attempts; wait a minute and try again',
  ],
  [
    DISCOVERY_ERROR_CODES.UNAVAILABLE,
    'the index is down or does not take registrations now; try again later or contact Gyblos',
  ],
  [DISCOVERY_ERROR_CODES.REGISTRATION_REJECTED, NOT_OFFERED],
]);

async function inviteOf(output: SellerOutput, prompt: Prompt | undefined) {
  const given = output.env[REGISTER.inviteEnv];
  if (given !== undefined) return given.trim();
  if (!prompt) return undefined;
  return (await prompt('Invite code (from your Gyblos invitation): ')).trim();
}

class RegistrationUnavailable extends Error {
  constructor(
    readonly code?: NodeErrorCode,
    readonly missingLamports?: bigint,
    readonly requiredLamports?: bigint,
  ) {
    super();
  }
}
function registrationUnavailableHint(error: RegistrationUnavailable): string {
  return error.code === NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED &&
    error.missingLamports !== undefined &&
    error.requiredLamports !== undefined
    ? `you need ${registrationSol(error.missingLamports)} more SOL for the estimated ${registrationSol(error.requiredLamports)} SOL registration; fund the owner and retry`
    : error.code === NODE_ERROR_CODES.SELLER_REGISTRATION_SIMULATION_FAILED
      ? 'registration simulation failed; ensure the owner has SOL, then retry to estimate the cost'
      : 'registration is not confirmed; check the wallet and retry later without deleting its local state';
}
async function registerWithIdentity(
  attempt: () => Promise<
    (typeof REGISTRATION_RESULTS)[keyof typeof REGISTRATION_RESULTS]
  >,
  registerIdentity?: () => Promise<boolean>,
) {
  try {
    return await attempt();
  } catch (error) {
    if (
      !(error instanceof DiscoveryError) ||
      error.code !== DISCOVERY_ERROR_CODES.IDENTITY_NOT_REGISTERED ||
      !registerIdentity
    )
      throw error;
    let ready = false;
    try {
      ready = await registerIdentity();
    } catch (cause) {
      throw new RegistrationUnavailable(
        cause instanceof NodeError ? cause.code : undefined,
        cause instanceof NodeError ? cause.missingLamports : undefined,
        cause instanceof NodeError ? cause.requiredLamports : undefined,
      );
    }
    if (!ready) throw new RegistrationUnavailable();
    return attempt();
  }
}

export async function registerCommand(
  output: SellerOutput,
  system: {
    fetch: DiscoveryFetch;
    prompt?: Prompt;
    registerIdentity?: () => Promise<boolean>;
  },
) {
  const fail = (code: string, hint: string) => {
    output.stderr(`${code}: ${hint}\n`);
    return EXIT.failure;
  };
  const identity = await sellerIdentity(homeEnvironmentOf(output), output);
  if (!identity) return EXIT.failure;
  const discovery = await discoverySettings(output, true);
  if (!discovery)
    return fail(
      REGISTER_ERRORS.CONFIG_INVALID,
      'configuration invalid; run `pnpm gyblos doctor`',
    );
  const invite = await inviteOf(output, system.prompt);
  if (!invite)
    return fail(
      REGISTER_ERRORS.NO_INVITE,
      `set ${REGISTER.inviteEnv}, or run this on a terminal to be asked`,
    );
  if (!REGISTRATION_FORMAT.invite.test(invite))
    return fail(
      REGISTER_ERRORS.INVITE_FORMAT,
      `that is not an invite code; it is ${INVITE_SHAPE}`,
    );
  if (identity.payTo !== undefined && identity.payTo !== identity.owner)
    output.stderr(
      'Warning: payout is different from owner; accepted temporarily for the beta. The 8004 owner remains unchanged.\n',
    );
  output.stdout(
    `Registering seller ${identity.nodeId} with ${urlOrigin(discovery.url)}\n`,
  );
  const prompt = system.prompt;
  const registerIdentity =
    system.registerIdentity ??
    (prompt ? () => registerOnChain(output, identity, prompt) : undefined);
  const attempt = () =>
    registerSeller({
      baseUrl: discovery.url,
      invite,
      nodeId: identity.nodeId,
      fetch: system.fetch,
      timeoutMs: REGISTER.timeoutMs,
    });
  let result;
  try {
    result = await registerWithIdentity(attempt, registerIdentity);
  } catch (error) {
    if (error instanceof RegistrationUnavailable)
      return fail(
        REGISTER_ERRORS.IDENTITY_UNAVAILABLE,
        registrationUnavailableHint(error),
      );
    if (!(error instanceof DiscoveryError)) throw error;
    const hint =
      error.code === DISCOVERY_ERROR_CODES.HTTP_STATUS &&
      error.status === HTTP_NOT_FOUND
        ? NOT_OFFERED
        : HINTS.get(error.code);
    return fail(error.code, hint ?? RETRY_LATER);
  }
  output.stdout(
    result === REGISTRATION_RESULTS.REGISTERED
      ? 'Registered: this seller may now publish.\n'
      : 'Already registered: this seller may publish.\n',
  );
  if (!discovery.publish)
    output.stdout(
      '  Publishing is off in gyblos.toml; set publish = true under [discovery] to be listed.\n',
    );
  return EXIT.ok;
}
