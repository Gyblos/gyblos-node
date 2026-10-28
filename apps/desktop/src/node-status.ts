// Public local-runtime state only; never represents remote connectivity or wallet health.
export const LOCAL_NODE_STATE = {
  STARTING: 'starting',
  READY: 'ready',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error',
} as const;
export const LOCAL_NODE = {
  STATUS_CHANNEL: 'desktop:node-status',
  RETRY_CHANNEL: 'desktop:node-retry',
  READY: 'node:ready',
  STOP: 'node:stop',
  START_TIMEOUT_MS: 15000,
  STOP_TIMEOUT_MS: 5000,
  POLL_MS: 600,
} as const;
export type LocalNodeState =
  (typeof LOCAL_NODE_STATE)[keyof typeof LOCAL_NODE_STATE];
export function parseLocalNodeState(_value: unknown): LocalNodeState {
  return LOCAL_NODE_STATE.ERROR;
}
