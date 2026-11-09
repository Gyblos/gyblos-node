// The seller's next onboarding step (register, publish, confirm the listing), shared by `gyblos seller
// register` and `gyblos seller status` so an operator always sees what to do next.

export const FAUCET = 'https://faucet.solana.com, choose devnet';

// gyblos.toml is read-only inside the installer's container, so publishing is a step on the host.
export const PUBLISH_STEP =
  'set publish = true under [discovery] in gyblos.toml and restart the seller (installed with install.sh: run `sh install.sh publish` where you saved it, with GYBLOS_DIR if you installed elsewhere; download install.sh again if it does not know publish)';

export const LISTING = {
  OFF: 'off',
  UNCHECKED: 'unchecked',
  LISTED: 'listed',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
} as const;
export type Listing = (typeof LISTING)[keyof typeof LISTING];

// The command as the operator types it: through compose for the installer's container, pnpm otherwise.
export function sellerCommand(container: boolean, command: string) {
  return container
    ? `docker compose exec seller gyblos ${command}`
    : `pnpm gyblos ${command}`;
}

export function nextStep(
  listing: Listing,
  owner: string,
  container: boolean,
): string | undefined {
  const register = `\`${sellerCommand(container, 'seller register')}\``;
  switch (listing) {
    case LISTING.OFF:
      return `publish: ${PUBLISH_STEP}. If this seller is not registered yet, first run ${register} with your gyb_ invite code (the owner ${owner} pays about 0.01 devnet SOL once; ${FAUCET}).`;
    case LISTING.UNCHECKED:
      return `\`${sellerCommand(container, 'seller status --online')}\` checks that the index lists this seller.`;
    case LISTING.ABSENT:
      return `if this seller is not registered yet, run ${register}; a registered, published seller is listed within about two minutes.`;
    default:
      return undefined;
  }
}
