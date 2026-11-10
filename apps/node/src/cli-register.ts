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
import {
  FUNDS_WAIT,
  SELLER_FUNDS,
  waitForOwnerFunds,
  type FundsWaitResult,
} from '@gyblos/node/seller-funds';

import { urlOrigin } from './cli-format';
import type { Prompt } from './cli-init';
import { FAUCET, PUBLISH_STEP } from './cli-next';
import {
  registerOnChain,
  RegistrationDeclined,
  registrationSol,
} from './cli-register-identity';
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

// The invite, or why there is none: an empty answer, an empty variable or no way to ask are told apart.
async function checkedInvite(
  output: SellerOutput,
  prompt: Prompt | undefined,
): Promise<{ value: string } | { code: string; hint: string }> {
  const value = await inviteOf(output, prompt);
  if (!value)
    return {
      code: REGISTER_ERRORS.NO_INVITE,
      hint:
        output.env[REGISTER.inviteEnv] !== undefined
          ? `${REGISTER.inviteEnv} is empty; set it to the gyb_ code from your invitation`
          : prompt
            ? 'no invite code was entered; paste the gyb_ code from your invitation, then press Enter'
            : `set ${REGISTER.inviteEnv}, or run this on a terminal to be asked`,
    };
  if (!REGISTRATION_FORMAT.invite.test(value))
    return {
      code: REGISTER_ERRORS.INVITE_FORMAT,
      hint: `that is not an invite code; it is ${INVITE_SHAPE}`,
    };
  return { value };
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
function registrationUnavailableHint(
  error: RegistrationUnavailable,
  owner: string,
): string {
  return error.code === NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED &&
    error.missingLamports !== undefined &&
    error.requiredLamports !== undefined
    ? `you need ${registrationSol(error.missingLamports)} more SOL for the estimated ${registrationSol(error.requiredLamports)} SOL registration; send devnet SOL to the owner ${owner} (${FAUCET}), then run this again`
    : error.code === NODE_ERROR_CODES.SELLER_REGISTRATION_SIMULATION_FAILED
      ? `registration simulation failed; send devnet SOL to the owner ${owner} (${FAUCET}), then run this again to estimate the cost`
      : 'registration is not confirmed; check the wallet and retry later without deleting its local state';
}
// Waits for the owner to hold the lamports, calling onWaiting once if it has to wait.
export type FundsWait = (
  owner: string,
  lamports: bigint,
  onWaiting: () => void,
) => Promise<FundsWaitResult>;
const STOPPED_WAITING: Partial<Record<FundsWaitResult, string>> = {
  [FUNDS_WAIT.STOPPED]: 'Stopped waiting for SOL.\n',
  [FUNDS_WAIT.UNREADABLE]:
    "Could not read the owner's balance from the configured RPC; check rpc in the seller role or try again later.\n",
};

// The balance to wait for when registration stopped for want of SOL; undefined for any other stop.
function fundingTarget(error: RegistrationUnavailable) {
  if (
    error.code === NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED &&
    error.requiredLamports !== undefined
  )
    return error.requiredLamports;
  return error.code === NODE_ERROR_CODES.SELLER_REGISTRATION_SIMULATION_FAILED
    ? REGISTER.simulationFundingLamports
    : undefined;
}
function waitingMessage(
  error: RegistrationUnavailable,
  owner: string,
  target: bigint,
) {
  const need =
    error.missingLamports !== undefined
      ? `needs ${registrationSol(error.missingLamports)} more SOL for the estimated ${registrationSol(target)} SOL registration`
      : `needs devnet SOL (about ${registrationSol(target)} SOL) before the registration can be estimated`;
  return `The owner ${owner} ${need}.\n  Send devnet SOL to it (${FAUCET}).\n  Waiting for it to arrive, checking every ${SELLER_FUNDS.pollText}. Press Ctrl+C to stop; run this again later and nothing is lost.\n`;
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
      if (cause instanceof RegistrationDeclined) throw cause;
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

// Registers; on a terminal, a registration stopped for want of SOL waits for the owner's SOL and tries
// again (it asks for confirmation again with the new estimate).
async function registerWaitingForFunds(
  register: () => ReturnType<typeof registerWithIdentity>,
  owner: string,
  output: SellerOutput,
  waitForFunds: FundsWait | undefined,
) {
  for (let waits = 0; ; waits += 1) {
    try {
      return await register();
    } catch (error) {
      const target =
        error instanceof RegistrationUnavailable
          ? fundingTarget(error)
          : undefined;
      if (
        !waitForFunds ||
        target === undefined ||
        waits >= REGISTER.fundWaits ||
        !(error instanceof RegistrationUnavailable)
      )
        throw error;
      const result = await waitForFunds(owner, target, () =>
        output.stdout(waitingMessage(error, owner, target)),
      );
      if (result === FUNDS_WAIT.ARRIVED)
        output.stdout('SOL received; continuing the registration.\n');
      // Already funded: a funds shortfall resolved meanwhile is retried; a failed simulation is not
      // about SOL, so it stops with its own hint.
      else if (
        result !== FUNDS_WAIT.FUNDED ||
        error.code !== NODE_ERROR_CODES.SELLER_REGISTRATION_FUNDS_REQUIRED
      ) {
        const told = STOPPED_WAITING[result];
        if (told) output.stdout(told);
        throw error;
      }
    }
  }
}

// Waiting needs someone watching: only on a terminal.
function fundsWait(
  system: {
    prompt?: Prompt;
    waitForFunds?: FundsWait;
    interrupt?: AbortSignal;
  },
  rpcUrl: string,
): FundsWait | undefined {
  if (!system.prompt) return undefined;
  return (
    system.waitForFunds ??
    ((owner, lamports, onWaiting) =>
      waitForOwnerFunds({
        rpcUrl,
        owner,
        lamports,
        onWaiting,
        signal: system.interrupt,
      }))
  );
}

export interface RegisterSystem {
  fetch: DiscoveryFetch;
  prompt?: Prompt;
  registerIdentity?: () => Promise<boolean>;
  waitForFunds?: FundsWait;
  // Aborted by Ctrl+C on the terminal the prompt reads.
  interrupt?: AbortSignal;
}

export async function registerCommand(
  output: SellerOutput,
  system: RegisterSystem,
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
      'configuration invalid; run `gyblos doctor`',
    );
  const invite = await checkedInvite(output, system.prompt);
  if ('code' in invite) return fail(invite.code, invite.hint);
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
      invite: invite.value,
      nodeId: identity.nodeId,
      fetch: system.fetch,
      timeoutMs: REGISTER.timeoutMs,
    });
  let result;
  try {
    result = await registerWaitingForFunds(
      () => registerWithIdentity(attempt, registerIdentity),
      identity.owner,
      output,
      fundsWait(system, identity.rpcUrl),
    );
  } catch (error) {
    if (error instanceof RegistrationDeclined)
      return fail(
        REGISTER_ERRORS.CANCELLED,
        'nothing was signed or sent; run this again and answer yes to register',
      );
    if (error instanceof RegistrationUnavailable)
      return fail(
        REGISTER_ERRORS.IDENTITY_UNAVAILABLE,
        registrationUnavailableHint(error, identity.owner),
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
      `  Publishing is off in gyblos.toml. Next: ${PUBLISH_STEP}\n`,
    );
  return EXIT.ok;
}
