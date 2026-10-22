// Owns offline native runtime regression cases; no funded wallets or live services.
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';

const BINDING_UNAVAILABLE =
  /Cannot find native binding|Failed to load native binding|Unsupported (?:architecture|platform)/i;
const IPV6_UNAVAILABLE = new Set([
  'EAFNOSUPPORT',
  'EPROTONOSUPPORT',
  'EADDRNOTAVAIL',
  'EACCES',
  'EPERM',
]);

type NativeSdk = typeof import('@number0/iroh');
interface NativeCapability {
  sdk?: NativeSdk;
  bindingSkip: false | string;
  transportSkip: false | string;
}

async function ipv6Loopback() {
  const socket = createSocket('udp6');
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '::1', resolve);
    });
  } finally {
    try {
      socket.close();
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING'
      )
        throw error;
    }
  }
}

async function capability(): Promise<NativeCapability> {
  let sdk: NativeSdk;
  try {
    sdk = await import('@number0/iroh');
  } catch (error) {
    if (!(error instanceof Error) || !BINDING_UNAVAILABLE.test(error.message))
      throw error;
    const reason =
      'Native Iroh binding unavailable on this platform: ' +
      error.message.split('\n')[0];
    return { bindingSkip: reason, transportSkip: reason };
  }
  try {
    await ipv6Loopback();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !IPV6_UNAVAILABLE.has(code)) throw error;
    return {
      sdk,
      bindingSkip: false,
      transportSkip: 'Native Iroh requires IPv6 loopback [::1]: ' + code,
    };
  }
  return { sdk, bindingSkip: false, transportSkip: false };
}

export const NATIVE_CAPABILITY = await capability();
export const NATIVE_TEST_OPTIONS = { skip: NATIVE_CAPABILITY.transportSkip };

export async function waitFor(
  condition: () => boolean,
  milliseconds = 3500,
  description = 'native condition',
) {
  const deadline = performance.now() + milliseconds;
  while (!condition()) {
    if (performance.now() >= deadline)
      throw new Error('Timed out waiting for ' + description);
    await delay(2);
  }
}
