import { BUYER_COMMANDS, BUYER_HELP_FLAGS } from '@gyblos/buyer/constants';

type BuyerCommand = (typeof BUYER_COMMANDS)[keyof typeof BUYER_COMMANDS];
type BuyerRoute = (args: readonly string[]) => Promise<unknown>;
export type BuyerRoutes = Readonly<Record<BuyerCommand, BuyerRoute>>;

interface Output {
  write(text: string): unknown;
}

const USAGE = `Usage: buyer <command> [options]
       buyer ${BUYER_COMMANDS.START}      (the buyer endpoint: free or paid, chosen from each signed quote)
       buyer ${BUYER_COMMANDS.FREE}       (the buyer endpoint for free quotes only)
       buyer ${BUYER_COMMANDS.CHAT}       (a terminal chat over the buyer)
       buyer ${BUYER_COMMANDS.INIT} [--advanced] [--help]
       buyer ${BUYER_COMMANDS.SETUP}      (prepares the pinned tokenizer)
       buyer ${BUYER_COMMANDS.AUTO} <max input USDC/Mtok> <max output USDC/Mtok> | off
       buyer ${BUYER_COMMANDS.AGENT} <opencode|pi|codex|claude> [--write] [--context <tokens>] [--token-env <NAME>]
       buyer ${BUYER_COMMANDS.WITHDRAW}   (withdraws from closed payment channels)
`;

export const BUYER_ROUTES: BuyerRoutes = {
  [BUYER_COMMANDS.START]: async () => {
    const { startBuyer } = await import('@gyblos/buyer/buyer-startup');
    return (await import('./free-main')).main(startBuyer);
  },
  [BUYER_COMMANDS.FREE]: async () => (await import('./free-main')).main(),
  [BUYER_COMMANDS.CHAT]: async () => (await import('./chat-cli')).main(),
  [BUYER_COMMANDS.INIT]: async (args) =>
    (await import('./init')).main([...args]),
  [BUYER_COMMANDS.SETUP]: async () => (await import('./setup')).main(),
  [BUYER_COMMANDS.AUTO]: async (args) =>
    (await import('./auto-cli')).main([...args]),
  [BUYER_COMMANDS.AGENT]: async (args) =>
    (await import('./agent-cli')).main([...args]),
  [BUYER_COMMANDS.WITHDRAW]: async () =>
    (await import('./withdraw-paid')).main(),
};

export async function run(
  args: readonly string[],
  routes: BuyerRoutes = BUYER_ROUTES,
  output: { out: Output; err: Output } = {
    out: process.stdout,
    err: process.stderr,
  },
): Promise<1 | undefined> {
  const [command, ...rest] = args;
  if (command !== undefined && BUYER_HELP_FLAGS.includes(command)) {
    output.out.write(USAGE);
    return undefined;
  }
  const known = Object.values(BUYER_COMMANDS).find((name) => name === command);
  if (!known) {
    output.err.write(USAGE);
    return 1;
  }
  await routes[known](rest);
  return undefined;
}
