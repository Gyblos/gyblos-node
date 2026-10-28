// Public first-run contract: only an action, bounded password and sanitized state cross IPC.
// Backup bytes, selected paths and wallet keys stay in the host.
import { BACKUP } from './backup/constants';
import { SETUP_ACTION, SETUP_ERROR, SETUP_STATUS } from './constants';
import { parseWalletSummary, WALLET_STATUS } from './model';

export {
  SETUP_ACTION,
  SETUP_ERROR,
  SETUP_STATUS,
  WALLET_SETUP,
} from './constants';
type SetupAction = (typeof SETUP_ACTION)[keyof typeof SETUP_ACTION];
type SetupStatus = (typeof SETUP_STATUS)[keyof typeof SETUP_STATUS];
type SetupError = (typeof SETUP_ERROR)[keyof typeof SETUP_ERROR];
export type SetupRequest =
  | { action: typeof SETUP_ACTION.RESTORE; password: string }
  | { action: Exclude<SetupAction, typeof SETUP_ACTION.RESTORE> };
export interface SetupView {
  status: SetupStatus;
  address: string | null;
  error: SetupError | null;
}
export function setupView(
  status: SetupStatus,
  error: SetupError | null = null,
  address: string | null = null,
): SetupView {
  return { status, address, error };
}
export function validSetupPassword(password: string) {
  const bytes = new TextEncoder().encode(password);
  return (
    bytes.length >= BACKUP.MIN_PASSWORD_BYTES &&
    bytes.length <= BACKUP.MAX_PASSWORD_BYTES &&
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) === password
  );
}
export function parseSetupRequest(value: unknown): SetupRequest | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('action' in value)
  )
    return null;
  const action = Object.values(SETUP_ACTION).find(
    (item) => item === value.action,
  );
  if (!action) return null;
  if (action !== SETUP_ACTION.RESTORE)
    return Object.keys(value).join(',') === 'action' ? { action } : null;
  if (
    Object.keys(value).sort().join(',') !== 'action,password' ||
    !('password' in value) ||
    typeof value.password !== 'string' ||
    !validSetupPassword(value.password)
  )
    return null;
  return { action, password: value.password };
}
export function parseSetupView(value: unknown): SetupView {
  const invalid = () => setupView(SETUP_STATUS.BLOCKED, SETUP_ERROR.FAILED);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'address,error,status' ||
    !('status' in value) ||
    !('error' in value) ||
    !('address' in value)
  )
    return invalid();
  const status = Object.values(SETUP_STATUS).find(
    (item) => item === value.status,
  );
  const error =
    value.error === null
      ? null
      : Object.values(SETUP_ERROR).find((item) => item === value.error);
  if (!status || error === undefined) return invalid();
  if (status === SETUP_STATUS.RESTORED) {
    const wallet = parseWalletSummary({
      status: WALLET_STATUS.READY,
      address: value.address,
      backupVerified: false,
      fundingEnabled: false,
    });
    return wallet.address
      ? setupView(status, error, wallet.address)
      : invalid();
  }
  return value.address === null ? setupView(status, error) : invalid();
}
