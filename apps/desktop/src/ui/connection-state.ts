// In-memory preview connection policies; never creates credentials or contacts a tool.
import { CONNECTION_BUDGET, CONNECTION_TOOLS } from './constants';

export { CONNECTION_TOOLS } from './constants';

export type ConnectionTool = (typeof CONNECTION_TOOLS)[number];
export type PreviewConnection = {
  tool: ConnectionTool;
  modelId: string;
  dailyBudget: number;
};
export function connectionPolicy(
  tool: ConnectionTool,
  modelId: string,
  budget: string,
): PreviewConnection | null {
  const dailyBudget = Number(budget);
  if (
    !budget.trim() ||
    !Number.isFinite(dailyBudget) ||
    dailyBudget <= 0 ||
    dailyBudget > CONNECTION_BUDGET.MAX_DAILY ||
    Math.round(dailyBudget * CONNECTION_BUDGET.CENTS) /
      CONNECTION_BUDGET.CENTS !==
      dailyBudget
  )
    return null;
  return { tool, modelId, dailyBudget };
}
export function saveConnection(
  connections: readonly PreviewConnection[],
  policy: PreviewConnection,
): PreviewConnection[] {
  const exists = connections.some((item) => item.tool === policy.tool);
  return exists
    ? connections.map((item) => (item.tool === policy.tool ? policy : item))
    : [...connections, policy];
}

// A tool connection must display and save a model from its own supplied options.
export function connectionModelId(
  preferred: string,
  _available: readonly [{ id: string }, ...{ id: string }[]],
): string {
  return preferred;
}
