import {
  AutoSettingsError,
  setBuyerRenewalBudget,
  withAutoPrices,
} from '@gyblos/buyer/auto-settings';
import { BUYER_COMMANDS, BUYER_SELECTION } from '@gyblos/buyer/constants';
import { ROLE_FILES, rolePathIn } from '@gyblos/config';
import { checkBuyerInit } from '@gyblos/node/buyer-init';
import {
  pricePerMtokToAtomicPerMtok,
  usdcToAtomic,
} from '@gyblos/node/node-config-price';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  acquireProcessLock,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

function autoUpdate(args: string[]) {
  const disable = args.length === 1 && args[0] === 'off';
  if (!disable && args.length !== 2)
    throw new AutoSettingsError(
      'Usage: pnpm buyer:auto <max input USDC/Mtok> <max output USDC/Mtok> | off',
    );
  const prices = disable
    ? undefined
    : {
        inputAtomicPerMtok: String(pricePerMtokToAtomicPerMtok(args[0]!)),
        outputAtomicPerMtok: String(pricePerMtokToAtomicPerMtok(args[1]!)),
      };
  return (value: unknown) => withAutoPrices(value, prices ?? null);
}
function budgetUpdate(args: string[]) {
  if (args.length !== 1)
    throw new AutoSettingsError('Usage: buyer budget <total USDC> | off');
  const budget = args[0] === 'off' ? null : String(usdcToAtomic(args[0]!));
  return setBuyerRenewalBudget(process.env, budget);
}
type SettingsCommand =
  typeof BUYER_COMMANDS.AUTO | typeof BUYER_COMMANDS.BUDGET;
async function configure(args: string[], mode: SettingsCommand) {
  if (mode === BUYER_COMMANDS.BUDGET) {
    await budgetUpdate(args);
    console.log('Renewal budget saved.');
    return;
  }
  const update = autoUpdate(args);
  const { path, exists } = await checkBuyerInit(process.env);
  if (!exists) throw new AutoSettingsError('Run buyer:init first.');
  const lock = await acquireProcessLock(
    rolePathIn(process.env, P2P_ROLES.BUYER, ROLE_FILES.buyerInitLock),
  );
  try {
    const data = await readPrivateFile(path, BUYER_SELECTION.maxConfigBytes);
    if (!data) throw new AutoSettingsError('Missing buyer settings.');
    const value: unknown = JSON.parse(data);
    const next = update(value);
    await lock.verify();
    await writePrivateFile(
      path,
      JSON.stringify(next, null, 2) + '\n',
      BUYER_SELECTION.maxConfigBytes,
    );
    console.log('Auto settings saved. Restart the buyer to apply them.');
  } finally {
    await lock.release();
  }
}
export async function main(
  args: string[],
  mode: SettingsCommand = BUYER_COMMANDS.AUTO,
) {
  try {
    await configure(args, mode);
  } catch (error) {
    console.error(
      error instanceof AutoSettingsError
        ? error.message
        : mode === BUYER_COMMANDS.BUDGET
          ? 'Could not configure the renewal budget.'
          : 'Could not configure Auto.',
    );
    process.exitCode = 1;
  }
}
