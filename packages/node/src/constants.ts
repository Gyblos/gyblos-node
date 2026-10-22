// Owns existing bounded call examples and node lifecycle states.
// It performs no wallet, network or process actions.
export const INFERENCE_CASES = {
  HONEST_1: 'honest-1',
  HONEST_2: 'honest-2',
  HONEST_3: 'honest-3',
  OVERCHARGE: 'overcharge',
  UNDERCHARGE: 'undercharge',
  ENGINE_INTERRUPTED: 'engine-interrupted',
} as const;

export const NODE_STATES = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
} as const;
export type NodeState = (typeof NODE_STATES)[keyof typeof NODE_STATES];
