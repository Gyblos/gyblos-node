// Composes the receipt uploader for a role's startup: release builds always upload to the collector;
// builds without GYBLOS_VERSION upload only when GYBLOS_COLLECTOR_URL is set (tests and development).
import { COLLECTOR_URL, RECEIPT_UPLOADER } from '@gyblos/config';
import { P2P_ROLES, type P2PRole } from '@gyblos/protocol/constants';
import {
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
  type ReceiptUploadClient,
} from '@gyblos/protocol/receipt-upload';
import type { Signer } from '@gyblos/protocol/signing';

import type { LocalReceiptStore } from './receipt-store';
import {
  createReceiptUploader,
  type ReceiptUploader,
} from './receipt-uploader';

const DEVELOPMENT_VERSION = '0.0.0-dev';
const PLATFORMS: Readonly<Record<string, ReceiptUploadClient['platform']>> = {
  darwin: RECEIPT_UPLOAD_PLATFORMS.MACOS,
  win32: RECEIPT_UPLOAD_PLATFORMS.WINDOWS,
  linux: RECEIPT_UPLOAD_PLATFORMS.LINUX,
};
const ARCHES: Readonly<Record<string, ReceiptUploadClient['arch']>> = {
  x64: RECEIPT_UPLOAD_ARCHES.X64,
  arm64: RECEIPT_UPLOAD_ARCHES.ARM64,
};
const APP_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

// The collector URL for this process, or undefined when uploading is off (non-release without a URL).
export function collectorUrl(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const configured = environment[RECEIPT_UPLOADER.urlEnvironment];
  if (configured) return configured.replace(/\/+$/, '');
  return environment[RECEIPT_UPLOADER.releaseEnvironment]
    ? COLLECTOR_URL
    : undefined;
}

// The desktop app runs the shared buyer inside Electron; anything else is the CLI or the seller daemon.
export function uploadClient(
  role: P2PRole,
  environment: NodeJS.ProcessEnv,
  runtime: { platform: string; arch: string; electron?: string } = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
  },
): ReceiptUploadClient {
  const version = environment[RECEIPT_UPLOADER.releaseEnvironment];
  return {
    kind:
      role === P2P_ROLES.SELLER
        ? RECEIPT_UPLOAD_CLIENTS.SELLER_NODE
        : runtime.electron
          ? RECEIPT_UPLOAD_CLIENTS.BUYER_DESKTOP
          : RECEIPT_UPLOAD_CLIENTS.BUYER_CLI,
    appVersion:
      version && APP_VERSION.test(version) ? version : DEVELOPMENT_VERSION,
    platform: PLATFORMS[runtime.platform] ?? RECEIPT_UPLOAD_PLATFORMS.OTHER,
    arch: ARCHES[runtime.arch] ?? RECEIPT_UPLOAD_ARCHES.OTHER,
  };
}

export interface RoleUploaderOptions {
  environment: NodeJS.ProcessEnv;
  store: Pick<LocalReceiptStore, 'listPending' | 'markUploaded'>;
  nodeId: string;
  role: P2PRole;
  signer: Signer;
}
// Started uploader for this role, or undefined when uploading is off. The caller closes it on stop.
export function startRoleUploader(
  options: RoleUploaderOptions,
): ReceiptUploader | undefined {
  const url = collectorUrl(options.environment);
  if (!url) return undefined;
  const uploader = createReceiptUploader({
    store: options.store,
    nodeId: options.nodeId,
    role: options.role,
    client: uploadClient(options.role, options.environment),
    signer: options.signer,
    url,
  });
  uploader.start();
  return uploader;
}
