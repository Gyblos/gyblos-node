export const LOCALHOST = '127.0.0.1';
export const PORTS = {
  seller: 4021,
  facilitator: 4022,
  ollama: 11436,
  ollamaSetup: 11437,
} as const;
export const url = (port: number) => `http://${LOCALHOST}:${port}`;
export const HOSTS = {
  seller: url(PORTS.seller),
  facilitator: url(PORTS.facilitator),
  ollama: url(PORTS.ollama),
  ollamaSetup: url(PORTS.ollamaSetup),
  ollamaBind: `${LOCALHOST}:${PORTS.ollama}`,
  ollamaSetupBind: `${LOCALHOST}:${PORTS.ollamaSetup}`,
} as const;
