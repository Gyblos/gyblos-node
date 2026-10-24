// Adapts Electron OS encryption, rejecting weak Linux storage; no filesystem or keys.
import { WALLET_PROVIDER, type WalletProvider } from './constants.js';

export interface SafeStoragePort {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }>;
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface WalletProtection {
  provider: WalletProvider;
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

// Electron 45 exposes the Linux backend only for its synchronous API. Do not
// use that result to assert the different async provider is secure. Revisit at 46.
export function walletProtection(
  platform: NodeJS.Platform,
  storage: SafeStoragePort,
): WalletProtection | null {
  if (platform === 'linux') {
    const allowed = new Set([
      'gnome_libsecret',
      'kwallet',
      'kwallet5',
      'kwallet6',
    ]);
    const available = () =>
      storage.isEncryptionAvailable() &&
      allowed.has(storage.getSelectedStorageBackend());
    return {
      provider: WALLET_PROVIDER.LINUX,
      available: async () => available(),
      encrypt: async (value) => {
        if (!available())
          throw new Error('Protected wallet storage unavailable.');
        return storage.encryptString(value);
      },
      decrypt: async (value) => {
        if (!available())
          throw new Error('Protected wallet storage unavailable.');
        return storage.decryptString(value);
      },
    };
  }
  if (platform !== 'darwin' && platform !== 'win32') return null;
  return {
    provider:
      platform === 'darwin' ? WALLET_PROVIDER.MAC : WALLET_PROVIDER.WINDOWS,
    available: () => storage.isAsyncEncryptionAvailable(),
    encrypt: (value) => storage.encryptStringAsync(value),
    decrypt: async (value) => (await storage.decryptStringAsync(value)).result,
  };
}
