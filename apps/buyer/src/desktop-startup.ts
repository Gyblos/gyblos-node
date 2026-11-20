// Prepares the desktop's private buyer home and delegates startup on its stable loopback port.
// A confirmed maximum updates the managed profile before the listener opens.
import { PORTS, ROLE_FILES, rolePathIn } from '@gyblos/config';
import {
  BATCH_SESSION_DEFAULTS,
  BUYER_SESSION_DEFAULT_POLICY,
} from '@gyblos/config/batch-session';
import {
  buyerInitDefaults,
  checkBuyerInit,
  initializeBuyer,
  type BuyerInitOptions,
} from '@gyblos/node/buyer-init';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { controlAtomic } from '@gyblos/protocol/control-validation';
import {
  acquireProcessLock,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { BUYER_SELECTION } from './constants';
import { parseBuyerSelectionConfig } from './selection-config';

function desktopSession(raw: object) {
  if (!('session' in raw)) return BUYER_SESSION_DEFAULT_POLICY;
  const session = raw.session;
  if (
    session &&
    typeof session === 'object' &&
    'depositAtomic' in session &&
    BigInt(controlAtomic(session.depositAtomic)) <
      BigInt(BATCH_SESSION_DEFAULTS.minDepositAtomic)
  ) {
    return {
      ...session,
      depositAtomic: BUYER_SESSION_DEFAULT_POLICY.depositAtomic,
    };
  }
  return session;
}
async function configureDesktopPolicy(
  options: BuyerInitOptions,
  path: string,
  maximum: string,
) {
  const lock = await acquireProcessLock(
    rolePathIn(options.environment, P2P_ROLES.BUYER, ROLE_FILES.buyerInitLock),
  );
  try {
    const bytes = await readPrivateFile(path, BUYER_SELECTION.maxConfigBytes);
    if (!bytes) throw new Error('Missing buyer configuration');
    const raw: unknown = JSON.parse(bytes);
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('request' in raw) ||
      !raw.request ||
      typeof raw.request !== 'object' ||
      !('maxAtomic' in raw.request)
    )
      throw new Error('Invalid buyer configuration');
    controlAtomic(raw.request.maxAtomic);
    const updated = {
      ...raw,
      request: { ...raw.request, maxAtomic: maximum },
      session: desktopSession(raw),
    };
    parseBuyerSelectionConfig(updated);
    await lock.verify();
    options.signal?.throwIfAborted();
    await writePrivateFile(
      path,
      JSON.stringify(updated, null, 2) + '\n',
      BUYER_SELECTION.maxConfigBytes,
    );
  } finally {
    await lock.release();
  }
}
export async function prepareDesktopBuyer(
  options: BuyerInitOptions,
  maximum?: string,
): Promise<void> {
  options.signal?.throwIfAborted();
  if (maximum !== undefined && controlAtomic(maximum) === '0')
    throw new Error('A positive maximum is required');
  const current = await checkBuyerInit(options.environment);
  if (!current.exists) await initializeBuyer(buyerInitDefaults(), options);
  if (maximum !== undefined)
    await configureDesktopPolicy(options, current.path, maximum);
}

// The caller owns transport creation. Ordinary starts preserve existing settings.
export async function startDesktopBuyer<Host>(
  options: BuyerInitOptions,
  start: (options: { port: number }) => Promise<Host>,
  maximum?: string,
): Promise<Host> {
  await prepareDesktopBuyer(options, maximum);
  options.signal?.throwIfAborted();
  return start({ port: PORTS.desktopBuyer });
}
