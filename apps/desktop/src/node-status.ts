// Public local-runtime state only; never represents remote connectivity or wallet health.
import { LOCAL_NODE_STATE } from './constants';

export { LOCAL_NODE, LOCAL_NODE_STATE } from './constants';

export type LocalNodeState =
  (typeof LOCAL_NODE_STATE)[keyof typeof LOCAL_NODE_STATE];
export function parseLocalNodeState(value: unknown): LocalNodeState {
  return (
    Object.values(LOCAL_NODE_STATE).find((state) => state === value) ??
    LOCAL_NODE_STATE.ERROR
  );
}
