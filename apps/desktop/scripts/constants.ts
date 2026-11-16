// Fixed public artifacts copied into the desktop package.
import { DESKTOP_X402 } from '../src/x402/constants';

export const DESKTOP_ASSETS = [
  'main.cjs',
  'preload.cjs',
  'worker.cjs',
  'node-worker.cjs',
  DESKTOP_X402.SERVICE_FILE,
  'renderer',
] as const;

// The released app's identity. The product name is the macOS app and the Linux /opt folder; the executable
// is the command and the Debian package name.
export const DESKTOP_PACKAGE = {
  name: 'Gyblos',
  executable: 'gyblos-desktop',
  bundleId: 'com.gyblos.desktop',
  maintainer: 'Gyblos',
  // The .deb maintainer scripts: executable by root, readable by all.
  scriptMode: 0o755,
} as const;

// Release targets with an iroh native binding: no macOS x64 binding is published.
export interface DesktopTarget {
  name: string;
  platform: 'darwin' | 'win32' | 'linux';
  arch: 'arm64' | 'x64';
  binding: string;
}
export const DESKTOP_TARGETS: readonly DesktopTarget[] = [
  {
    name: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    binding: 'darwin-arm64',
  },
  {
    name: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    binding: 'win32-x64-msvc',
  },
  {
    name: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    binding: 'linux-x64-gnu',
  },
];
