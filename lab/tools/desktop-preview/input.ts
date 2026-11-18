// Narrows synthetic renderer requests without trusting arbitrary object shapes.
import type { AgentTool } from '@gyblos/node/agent-setup-constants';

export function requestObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : {};
}

export type AgentExamples = {
  usdc: Record<AgentTool, string>;
  paypal: Record<AgentTool, string>;
};
