// Loopback ports, host URLs, accepted Host names and the explorer origin.
export const LOCALHOST = '127.0.0.1';

export const PORTS = {
  facilitator: 4022,
  ollama: 11436,
} as const;

export const HOSTS = {
  facilitator: formatHostUrl(PORTS.facilitator),
  ollama: formatHostUrl(PORTS.ollama),
  ollamaBind: `${LOCALHOST}:${PORTS.ollama}`,
} as const;

export const IPV6_LOOPBACK = '[::1]';

const LOCALHOST_NAME = 'localhost';

// Host header names accepted by loopback-bound HTTP servers (DNS rebinding guard).
export const LOOPBACK_HOST_NAMES = [
  LOCALHOST,
  LOCALHOST_NAME,
  IPV6_LOOPBACK,
] as const;

const EXPLORER_ORIGIN = 'https://explorer.solana.com';

function formatHostUrl(port: number) {
  return `http://${LOCALHOST}:${port}`;
}

export const explorerUrl = (signature: string) =>
  `${EXPLORER_ORIGIN}/tx/${signature}?cluster=devnet`;
