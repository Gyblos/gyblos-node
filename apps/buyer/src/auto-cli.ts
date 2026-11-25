import { AutoSettingsError, withAutoPrices } from '@gyblos/buyer/auto-settings';
import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { ROLE_FILES, rolePathIn } from '@gyblos/config';
import { checkBuyerInit } from '@gyblos/node/buyer-init';
import { pricePerMtokToAtomicPerMtok } from '@gyblos/node/node-config-price';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  acquireProcessLock,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

async function configure(args: string[]) {
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
  const { path, exists } = await checkBuyerInit(process.env);
  if (!exists) throw new AutoSettingsError('Run buyer:init first.');
  const lock = await acquireProcessLock(
    rolePathIn(process.env, P2P_ROLES.BUYER, ROLE_FILES.buyerInitLock),
  );
  try {
    const data = await readPrivateFile(path, BUYER_SELECTION.maxConfigBytes);
    if (!data) throw new AutoSettingsError('Missing buyer settings.');
    const value: unknown = JSON.parse(data);
    const next = withAutoPrices(value, prices ?? null);
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
export async function main(args: string[]) {
  try {
    await configure(args);
  } catch (error) {
    console.error(
      error instanceof AutoSettingsError
        ? error.message
        : 'Could not configure Auto.',
    );
    process.exitCode = 1;
  }
}
