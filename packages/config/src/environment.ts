// Names of the node's GYBLOS_* operator environment variables that had no shared constant; GYBLOS_HOME,
// discovery and buyer relay-only names stay with their owners. Only runMode reads them, from the
// environment it is given.
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
  // Set to ENVIRONMENT_SWITCH.on by the packaged release's launcher (bin/gyblos): the home defaults to
  // ~/.gyblos and the service runs the launcher.
  packaged: 'GYBLOS_PACKAGED',
  // The packaged launcher's own path, which the service runs; only read when packaged.
  launcher: 'GYBLOS_LAUNCHER',
} as const;

// Value an operator sets to turn an environment switch on; today's readers compare against it exactly.
export const ENVIRONMENT_SWITCH = { on: '1', off: '0' } as const;

// How this seller was installed: from a source checkout (`pnpm gyblos`), as the seller image, or as the
// packaged release. Decides defaults and the commands printed to the operator.
export const RUN_MODES = {
  SOURCE: 'source',
  CONTAINER: 'container',
  PACKAGED: 'packaged',
} as const;
export type RunMode = (typeof RUN_MODES)[keyof typeof RUN_MODES];

export function runMode(
  environment: Readonly<Record<string, string | undefined>>,
): RunMode {
  if (environment[NODE_ENVIRONMENT.container] === ENVIRONMENT_SWITCH.on)
    return RUN_MODES.CONTAINER;
  if (environment[NODE_ENVIRONMENT.packaged] === ENVIRONMENT_SWITCH.on)
    return RUN_MODES.PACKAGED;
  return RUN_MODES.SOURCE;
}
