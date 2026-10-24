// Names of the node's GYBLOS_* operator environment variables that had no shared constant; GYBLOS_HOME,
// discovery and buyer relay-only names stay with their owners. Names only; nothing here reads them.
export const NODE_ENVIRONMENT = {
  rpcUrl: 'GYBLOS_RPC_URL',
  relays: 'GYBLOS_RELAYS',
  relayToken: 'GYBLOS_RELAY_TOKEN',
  relayOnly: 'GYBLOS_RELAY_ONLY',
  irohBind: 'GYBLOS_IROH_BIND',
  irohExternalAddress: 'GYBLOS_IROH_EXTERNAL_ADDR',
} as const;

// Value an operator sets to turn an environment switch on; today's readers compare against it exactly.
export const ENVIRONMENT_SWITCH = { on: '1', off: '0' } as const;
