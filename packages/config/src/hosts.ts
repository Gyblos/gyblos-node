export const LOCALHOST = '127.0.0.1';

export const PORTS = {
  seller: 4021,
  facilitator: 4022,
  ollama: 11436,
  ollamaSetup: 11437,
} as const;

export const HOSTS = {
  seller: formatHostUrl(PORTS.seller),
  facilitator: formatHostUrl(PORTS.facilitator),
  ollama: formatHostUrl(PORTS.ollama),
  ollamaSetup: formatHostUrl(PORTS.ollamaSetup),
  ollamaBind: `${LOCALHOST}:${PORTS.ollama}`,
  ollamaSetupBind: `${LOCALHOST}:${PORTS.ollamaSetup}`,
} as const;

export const IPV6_LOOPBACK = '[::1]';

export const EXPLORER_ORIGIN = 'https://explorer.solana.com';

export const PUBLIC_ORIGINS = { tokenizer: 'https://huggingface.co' } as const;

function formatHostUrl(port: number) {
  return `http://${LOCALHOST}:${port}`;
}

export const explorerUrl = (signature: string) =>
  `${EXPLORER_ORIGIN}/tx/${signature}?cluster=devnet`;

export const url = (port: number) => formatHostUrl(port);
