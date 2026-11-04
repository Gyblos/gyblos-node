// Names of the node's GYBLOS_* operator environment variables that had no shared constant; GYBLOS_HOME,
// discovery and buyer relay-only names stay with their owners. Names only; nothing here reads them.
export const NODE_ENVIRONMENT = {
  rpcUrl: 'GYBLOS_RPC_URL',
  relays: 'GYBLOS_RELAYS',
  relayToken: 'GYBLOS_RELAY_TOKEN',
  relayOnly: 'GYBLOS_RELAY_ONLY',
  irohBind: 'GYBLOS_IROH_BIND',
  irohExternalAddress: 'GYBLOS_IROH_EXTERNAL_ADDR',
  // Path to gyblos.toml for the seller daemon; without it ./gyblos.toml is read when present.
  config: 'GYBLOS_CONFIG',
  // Set to ENVIRONMENT_SWITCH.on by the seller image: `gyblos seller status` then looks for the daemon in
  // its own container instead of a systemd unit or launch agent.
  container: 'GYBLOS_CONTAINER',
} as const;

// Value an operator sets to turn an environment switch on; today's readers compare against it exactly.
export const ENVIRONMENT_SWITCH = { on: '1', off: '0' } as const;
